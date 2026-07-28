// Content script for form filling
import { llmManager } from './modules/ai/llm_manager.js';
import { loadPersonals, getPersonalsSync, Personals } from './modules/config_loader.js';
import { printLog, textualMatch } from './modules/helpers.js';

// Cached personals (loaded async at start)
let personals: Personals;

interface FormElement {
  element: HTMLElement;
  type: string;
  tagName: string;
  question?: string;
  options?: string[];
}

// === HELPER FUNCTIONS ===

/** Exact-or-subdomain match — `.includes('workday.com')` would also match `notworkday.com.evil.io`. */
function hostMatches(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

// Cache hostname checks once per page load (hostname never changes mid-session)
const _hostname = window.location.hostname.toLowerCase();
const _isWorkday = hostMatches(_hostname, 'workday.com') || hostMatches(_hostname, 'myworkday.com') || hostMatches(_hostname, 'myworkdayjobs.com');
const _isLinkedIn = hostMatches(_hostname, 'linkedin.com');

/**
 * Detect if current page is Workday (needs delays for bot detection evasion)
 */
function isWorkdayDomain(): boolean {
  return _isWorkday;
}

/**
 * Sleep utility for delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Get random delay - returns actual delay only if on Workday, otherwise 0
 */
function getConditionalDelay(min: number, max: number): number {
  if (!isWorkdayDomain()) return 0; // No delay for non-Workday sites
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Wait until selector matches under root (or timeout). Prefer over fixed sleeps. */
function waitForSelector(
  root: ParentNode,
  selector: string,
  timeoutMs: number = 800
): Promise<Element[]> {
  const existing = Array.from(root.querySelectorAll(selector));
  if (existing.length > 0) return Promise.resolve(existing);

  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const found = Array.from(root.querySelectorAll(selector));
      if (found.length > 0) {
        observer.disconnect();
        resolve(found);
      }
    });
    const target = root === document ? document.documentElement : (root as Node);
    observer.observe(target, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(Array.from(root.querySelectorAll(selector)));
    }, timeoutMs);
  });
}

function needsUiSettle(type: string): boolean {
  return type === 'listbox' || type === 'combobox' || type === 'select-one' ||
    type === 'select-multiple' || type === 'select' || type === 'radio' ||
    type === 'spl-radio-group' || type === 'ui5-date';
}

class FormFiller {
  private isRunning: boolean = false;
  private filledCount: number = 0;
  /** Cached once per fill run — simulateTabCommit must not rescan the whole DOM per field. */
  private focusableCache: HTMLElement[] | null = null;

  async startFilling(): Promise<number> {
    if (this.isRunning) {
      printLog("Form filling already in progress...");
      return this.filledCount;
    }

    this.isRunning = true;
    this.filledCount = 0;
    this.focusableCache = null;
    this.emitStatus();

    try {
      // Short yield for lazy-rendered fields (avoid long fixed 500+1000 sleeps)
      await sleep(100);

      // Detect elements first — bail silently for iframes and pages with no forms.
      let formElements = this.findFormElements();

      if (formElements.length === 0) {
        await sleep(300);
        formElements = this.findFormElements();
      }

      if (formElements.length === 0) {
        return 0;
      }

      printLog(`Starting form filling... (${formElements.length} elements)`);

      personals = await loadPersonals();
      printLog(
        `Personals loaded — ${(personals.experience_details || []).length} experience, ` +
        `${(personals.education_details || []).length} education entries`
      );

      // Single RPC: initializeClients returns availability
      const availability = await llmManager.initializeClients();
      if (availability.useAI && !availability.groqAvailable && !availability.hfAvailable) {
        printLog('No API keys configured — using offline fuzzy matching only.');
      }

      const settings = await this.getSettings();
      const batchModeEnabled = settings.batch_mode !== false;
      const chunkModeEnabled = settings.chunk_mode !== false;

      if (batchModeEnabled) {
        printLog(chunkModeEnabled ? "Using BATCH mode (chunked)" : "Using BATCH mode (all-at-once)");
        // Lean context: batch prompt already embeds entry arrays — don't double-send full personals
        const userInfo = personals.user_information_all || undefined;

        const CHUNK_SIZE = chunkModeEnabled ? 10 : formElements.length;
        for (let i = 0; i < formElements.length; i += CHUNK_SIZE) {
          const chunk = formElements.slice(i, i + CHUNK_SIZE);
          printLog(`Processing batch chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} elements)...`);

          const questionsList = chunk.map(el => ({
            question: this.getEnhancedQuestion(el),
            options: el.options,
            questionType: this.determineQuestionType(el.type, el.options)
          }));

          printLog(`Sending batch request for ${questionsList.length} questions...`);
          let batchAnswers = await llmManager.getBatchAnswers(
            questionsList,
            undefined,
            userInfo
          );

          // One retry for unmatched indices only — never per-field LLM storms in batch mode
          const missingIdx = questionsList
            .map((_, idx) => idx)
            .filter((idx) => !batchAnswers.get(idx)?.trim());
          if (missingIdx.length > 0 && missingIdx.length < questionsList.length) {
            printLog(`Batch retry for ${missingIdx.length} unmatched questions...`);
            const retryList = missingIdx.map((idx) => questionsList[idx]);
            const retryAnswers = await llmManager.getBatchAnswers(
              retryList,
              undefined,
              userInfo
            );
            retryAnswers.forEach((answer, localIdx) => {
              batchAnswers.set(missingIdx[localIdx], answer);
            });
          }
          printLog(`Got ${batchAnswers.size} answers for chunk`);

          for (let j = 0; j < chunk.length; j++) {
            const formElement = chunk[j];
            try {
              const cachedAnswer = batchAnswers.get(j);
              if (!cachedAnswer) {
                printLog(`No cached answer for: ${questionsList[j].question.substring(0, 60)}...`);
              }
              // allowPerFieldLlm=false: structured + cached + fuzzy only
              await this.fillElementWithAnswer(formElement, cachedAnswer, false);

              if (needsUiSettle(formElement.type)) {
                await this.delay(50);
              }
            } catch (error) {
              printLog(`Error filling element: ${error}`);
            }
          }

          if (i + CHUNK_SIZE < formElements.length) {
            await this.delay(100);
          }
        }

        if (_isLinkedIn) {
          await this.handleLinkedInValidationErrors();
        }
      } else {
        const delayMessage = _isWorkday ? " with delays for Workday detection evasion" : "";
        printLog(`Using SEQUENTIAL mode (more accurate)${delayMessage}`);

        for (const formElement of formElements) {
          await this.fillElement(formElement);
          const delay = getConditionalDelay(500, 1500);
          if (delay > 0) {
            await sleep(delay);
          } else if (needsUiSettle(formElement.type)) {
            await this.delay(50);
          }
        }

        if (_isLinkedIn) {
          await this.handleLinkedInValidationErrors();
        }
      }

      printLog(`Form filling complete! Filled ${this.filledCount} elements.`);
      return this.filledCount;
    } catch (error) {
      printLog(`Error during form filling: ${error}`);
      return this.filledCount;
    } finally {
      this.isRunning = false;
      this.focusableCache = null;
      this.emitStatus();
    }
  }

  private emitStatus(): void {
    try {
      chrome.runtime.sendMessage({
        action: 'fillStatus',
        isRunning: this.isRunning,
        filledCount: this.filledCount,
      }, () => {
        // Swallow "Receiving end does not exist" when popup is closed
        void chrome.runtime.lastError;
      });
    } catch {
      // Extension context unavailable
    }
  }

  /**
   * Detect and fix LinkedIn Easy Apply form validation errors.
   * Looks for error messages, re-prompts the LLM with error context, and re-fills fields.
   */
  private async handleLinkedInValidationErrors(maxRetries: number = 2): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Wait a moment for validation errors to appear in DOM
      await this.delay(300);

      const errors = this.detectLinkedInValidationErrors();
      if (errors.length === 0) {
        printLog('✅ No LinkedIn validation errors detected');
        return;
      }

      printLog(`⚠️ Found ${errors.length} LinkedIn validation error(s). Attempting fix (attempt ${attempt}/${maxRetries})...`);

      for (const { input, errorMessage, question } of errors) {
        const currentValue = (input as HTMLInputElement).value || '';
        printLog(`  Error on "${question}": "${errorMessage}" (current value: "${currentValue}")`);

        // Build a prompt that includes the error context
        const errorContextPrompt = `Question: "${question}"
Your previous answer "${currentValue}" was REJECTED with this validation error: "${errorMessage}"
Please provide a VALID answer that satisfies the validation requirement.
IMPORTANT: Only respond with the corrected value, nothing else.`;

        try {
          const userInfo = personals.user_information_all || JSON.stringify(personals);
          const correctedAnswer = await llmManager.getAnswer(
            errorContextPrompt,
            undefined,
            'text', // Force text type for correction
            undefined,
            userInfo,
            JSON.stringify(personals)
          );

          if (correctedAnswer && correctedAnswer !== currentValue) {
            printLog(`  LLM correction: "${correctedAnswer}"`);
            // Clear and re-fill the input
            (input as HTMLInputElement).value = '';
            await this.setElementValue(input, 'text', correctedAnswer, undefined);
            printLog(`  ✓ Re-filled with corrected value`);
          } else {
            printLog(`  ⚠️ LLM returned same or empty value, skipping`);
          }
        } catch (error) {
          printLog(`  Error getting correction: ${error}`);
        }
      }

      // Small delay before checking if errors are resolved
      await this.delay(300);
    }
  }

  /**
   * Find all LinkedIn validation errors in the current Easy Apply modal.
   * Returns array of {input, errorMessage, question} for each errored field.
   */
  private detectLinkedInValidationErrors(): { input: HTMLElement; errorMessage: string; question: string }[] {
    const errors: { input: HTMLElement; errorMessage: string; question: string }[] = [];

    // Get the modal container
    const modal = document.querySelector('[data-test-modal-id="easy-apply-modal"]') ||
      document.querySelector('.jobs-easy-apply-modal');
    if (!modal) return errors;

    // Find all error feedback elements
    const errorElements = modal.querySelectorAll('.artdeco-inline-feedback--error');

    errorElements.forEach(errorEl => {
      // Get the error message text
      const messageEl = errorEl.querySelector('.artdeco-inline-feedback__message');
      const errorMessage = messageEl?.textContent?.trim() || 'Unknown error';

      // Find the associated input - traverse up to the form element container
      const formElementContainer = errorEl.closest('[data-test-form-element]') ||
        errorEl.closest('.fb-dash-form-element');
      if (!formElementContainer) return;

      // Find the input within this container
      const input = formElementContainer.querySelector('input, textarea, select') as HTMLElement;
      if (!input) return;

      // Get the question/label
      const labelEl = formElementContainer.querySelector('label');
      const question = labelEl?.textContent?.trim() || 'Unknown field';

      errors.push({ input, errorMessage, question });
    });

    return errors;
  }

  /**
   * Helper to find the active form container.
   * On LinkedIn, this prioritizes the modal (Easy Apply) to avoid detecting search facets.
   * On other sites, it returns the document to ensure full page scanning.
   */
  private findActiveFormContainer(): HTMLElement | Document | null {
    // On LinkedIn, scope strictly to the Easy Apply modal to avoid search facets.
    if (_isLinkedIn) {
      const easyApplyModalId = document.querySelector('[data-test-modal-id="easy-apply-modal"]');
      if (easyApplyModalId) {
        printLog('✅ Scoped to Easy Apply modal');
        return easyApplyModalId as HTMLElement;
      }

      const easyApplyModalClass = document.querySelector('.jobs-easy-apply-modal');
      if (easyApplyModalClass) {
        printLog('✅ Scoped to Easy Apply modal');
        return easyApplyModalClass as HTMLElement;
      }

      printLog('⛔ LinkedIn: no Easy Apply modal found — blocking form detection');
      return null;
    }

    return document;
  }

  private findFormElements(): FormElement[] {
    const elements: FormElement[] = [];

    // Define the selector for form elements
    const formElementSelector = 'input, textarea, select, button[aria-haspopup="listbox"], ui5-date-picker-xweb-calendar-widget, spl-input, spl-textarea, spl-select, spl-autocomplete, spl-phone-field, spl-checkbox, spl-radio-group';

    // 0. Determine the root container (Scope the search)
    const root = this.findActiveFormContainer();

    if (!root) {
      // Strict mode triggered (e.g., LinkedIn with no modal)
      return [];
    }

    // 1. Find elements in Light DOM (scoped to root)
    const lightDomInputs = Array.from(root.querySelectorAll(formElementSelector));

    // 2. Find elements in Shadow DOM of specific containers (still check document for hosts, or scoped?)
    //    Ideally scoped, but shadow hosts usually live in the light DOM of the modal.
    const shadowInputs: Element[] = [];

    // Recursive helper to find all elements in shadow DOM (handles nested shadow hosts)
    const collectFromShadowDOM = (container: Element | ShadowRoot) => {
      const formElementSelector = 'input, textarea, select, button[aria-haspopup="listbox"], ui5-date-picker-xweb-calendar-widget, spl-input, spl-textarea, spl-select, spl-autocomplete, spl-phone-field, spl-checkbox, spl-radio-group';

      // Find direct form elements in current shadow
      const found = container.querySelectorAll(formElementSelector);
      shadowInputs.push(...Array.from(found));

      // Only recurse custom elements (likely shadow hosts) — avoid querySelectorAll('*') on every node
      const customElements = container.querySelectorAll('*');
      for (let i = 0; i < customElements.length; i++) {
        const el = customElements[i];
        if (!el.tagName.includes('-')) continue;
        if (el.shadowRoot) {
          collectFromShadowDOM(el.shadowRoot);
        }
      }
    };

    // Note: older logic querySelectorAll on document. If root is an element, we query on it.
    // However, root could be 'Document'. querySelectorAll works on both.
    const shadowHosts = root.querySelectorAll('sr-screening-questions-form, oc-screening-questions-form');

    shadowHosts.forEach(host => {
      if (host.shadowRoot) {
        collectFromShadowDOM(host.shadowRoot);
        printLog(`Recursively scanned Shadow DOM of ${host.tagName}`);
      }
    });

    // Combine all found inputs
    const inputs = [...lightDomInputs, ...shadowInputs];
    printLog(`Found ${inputs.length} total form elements (Light DOM: ${lightDomInputs.length}, Shadow DOM: ${shadowInputs.length})`);

    inputs.forEach((element) => {
      const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement | HTMLElement;

      // Skip hidden, submit, button elements (UNLESS it's a listbox button or spl-element)
      const isListbox = input.getAttribute('aria-haspopup') === 'listbox';
      const tagName = input.tagName.toLowerCase();
      const isSplElement = tagName.startsWith('spl-');

      if (!isListbox && !isSplElement) {
        // Safe check for type property
        const inputType = (input as any).type;
        if (inputType === 'hidden' ||
          inputType === 'submit' ||
          inputType === 'button' ||
          inputType === 'reset' ||
          inputType === 'image' ||
          inputType === 'password' ||
          inputType === 'file') {
          return;
        }
      }

      // Skip Workday utility buttons (Language, Settings, Account menus)
      if (input.getAttribute('data-automation-id') === 'utilityMenuButton' ||
        input.closest('[data-automation-id="utilityButtonBar"]')) {
        return;
      }

      // Skip disabled or readonly inputs
      // BUT: Allow Freshteam datepicker inputs (they use Bootstrap datepicker with readonly)
      const isFreshteamDatepicker = input.classList.contains('start_date') ||
        input.classList.contains('end_date') ||
        input.closest('.datepicker-popover') !== null;
      // Keka / jQuery-UI datepickers: readonly text inputs paired with a popup calendar.
      // Detected by the `hasDatepicker` class (jQuery-UI convention used by Keka) or
      // an `.input-calendar` wrapper. These must be filled even though they are readonly.
      const isJqueryUIDatepicker = input.classList.contains('hasDatepicker') ||
        input.closest('.input-calendar') !== null;
      const isReadonlyDatepicker = isFreshteamDatepicker || isJqueryUIDatepicker;
      if ((input as any).disabled) {
        return;
      }
      if (((input as any).readOnly || input.getAttribute('readonly') !== null) && !isReadonlyDatepicker) {
        return;
      }

      // Skip cookie consent/preference elements (not part of job application)
      const cookieKeywords = ['cookie', 'consent', 'gdpr', 'privacy-banner', 'cookie-banner', 'onetrust'];
      const elementId = (input.id || '').toLowerCase();
      const elementClass = (input.className || '').toLowerCase();
      const parentContainer = input.closest('[class*="cookie"], [class*="consent"], [id*="cookie"], [id*="consent"], [id*="onetrust"]');
      if (parentContainer || cookieKeywords.some(k => elementId.includes(k) || elementClass.includes(k))) {
        return;
      }

      // NOTE: LinkedIn search blacklist removed - findActiveFormContainer() already scopes to Easy Apply modal

      // Skip hidden elements (CSS hidden or HTML hidden attribute)
      // BUT: Skip these checks for spl-* elements (custom components may have non-standard styling)
      if (!isSplElement) {
        const cs = getComputedStyle(input);
        // Design systems (MUI, hirist, etc.) often visually hide the native
        // radio/checkbox and make the <label> the click target. Keep those
        // inputs if they have an associated <label for="..."> we can target.
        const inputType = (input as HTMLInputElement).type;
        const isRadioOrCheckbox = input.tagName.toLowerCase() === 'input' &&
          (inputType === 'radio' || inputType === 'checkbox');
        const hasAssociatedLabel = isRadioOrCheckbox && !!input.id &&
          !!document.querySelector(`label[for="${CSS.escape(input.id)}"]`);

        // Select2 visually hides the native <select> (visibility:hidden + aria-hidden=true)
        // and renders its own UI. The native element still owns the value, so we keep it
        // for filling — setting .value + dispatching change updates Select2's UI via its
        // own change listener.
        const isSelect2Hidden = input.tagName.toLowerCase() === 'select' &&
          input.classList.contains('select2-hidden-accessible');

        const isHidden = input.hidden ||
          input.getAttribute('hidden') !== null ||
          (input.getAttribute('aria-hidden') === 'true' && !isListbox && input.tagName.toLowerCase() !== 'ui5-date-picker-xweb-calendar-widget') ||
          cs.display === 'none' ||
          cs.visibility === 'hidden';

        if (isHidden && !hasAssociatedLabel && !isSelect2Hidden) {
          return;
        }
      } else {
        // For spl-* elements, log that we found one
        printLog(`[SPL] Found ${tagName}: id=${input.id || 'none'}, label=${input.getAttribute('label') || 'none'}`);
      }

      // FORCE FILL MODE: Don't skip based on existing values
      // Only skip if already checked checkboxes/radios AND they match what we would set
      // (We'll let the LLM decide what to set)

      // Select elements are always included (force fill mode)

      // For checkboxes/radios, include them (force fill will set based on LLM answer)
      // For text inputs, include them even if they have values (force fill)

      const question = this.extractQuestion(input);
      const options = this.extractOptions(input);

      // Check for combobox role or listbox popup
      let type = (input as any).type || 'text';
      if (input.tagName.toLowerCase() === 'ui5-date-picker-xweb-calendar-widget') {
        type = 'ui5-date';
        printLog(`Found UI5 Date Picker: ${question}`);
      } else if (isListbox) {
        type = 'listbox';
        printLog(`Found listbox button: ${question}`);
      } else if (input.getAttribute('role') === 'combobox') {
        type = 'combobox';
        printLog(`Found combobox: ${question}`);
      } else if (tagName.startsWith('spl-')) {
        // Determine type for spl-elements
        if (tagName === 'spl-select') {
          type = 'listbox'; // Use listbox logic (click and find options)
        } else if (tagName === 'spl-autocomplete') {
          type = 'combobox'; // Use combobox logic (type or click)
        } else if (tagName === 'spl-phone-field') {
          type = 'tel';
        } else if (tagName === 'spl-textarea') {
          type = 'textarea';
        } else if (tagName === 'spl-checkbox') {
          type = 'checkbox';
        } else if (tagName === 'spl-radio-group') {
          type = 'spl-radio-group';
        } else {
          // spl-input, check generic type attribute
          type = input.getAttribute('type') || 'text';
        }
        printLog(`Found custom element ${tagName}: ${question} (type: ${type})`);
      }

      elements.push({
        element: input,
        type: type,
        tagName: input.tagName.toLowerCase(),
        question,
        options
      });
    });

    // Also detect complex div-based form elements (DHTMLX, Material forms, etc.)
    // Pass the scoped root to ensure we don't pick up background elements
    const divBasedElements = this.findDivBasedFormElements(root);

    // Merge, avoiding duplicates (by element reference)
    const standardCount = elements.length;
    const existingElements = new Set(elements.map(e => e.element));
    let divAddedCount = 0;
    divBasedElements.forEach(divEl => {
      if (!existingElements.has(divEl.element)) {
        elements.push(divEl);
        divAddedCount++;
      }
    });

    if (elements.length > 0) {
      printLog(`Found ${elements.length} form elements (${standardCount} standard + ${divAddedCount} div-based)`);
    }
    return elements;
  }

  // Detect complex div-based form structures (DHTMLX, Material UI, Bootstrap, etc.)
  private findDivBasedFormElements(root: Element | Document = document): FormElement[] {
    const elements: FormElement[] = [];

    // Common patterns for div-based form layouts
    const formPatterns = [
      // DHTMLX forms
      { wrapper: '.dhxform_item_label_left, .dhxform_item_label_top', label: '.dhxform_label label, .dhxform_label_nav_link', control: '.dhxform_control input, .dhxform_control select, .dhxform_control textarea' },
      // Material Design forms
      { wrapper: '.mdc-text-field, .mat-form-field, .MuiFormControl-root', label: 'label, .mdc-floating-label, .mat-label', control: 'input, select, textarea' },
      // Bootstrap forms
      { wrapper: '.form-group, .mb-3', label: 'label, .form-label', control: 'input, select, textarea, .form-control' },
      // Generic patterns
      { wrapper: '[class*="form-field"], [class*="form-item"], [class*="field-wrapper"]', label: 'label, [class*="label"]', control: 'input, select, textarea' },
    ];

    for (const pattern of formPatterns) {
      const wrappers = root.querySelectorAll(pattern.wrapper);

      wrappers.forEach(wrapper => {
        // Find label within wrapper
        const labelEl = wrapper.querySelector(pattern.label);
        const labelText = labelEl ? this.getCleanLabelText(labelEl) : '';

        // Find input control within wrapper
        const controlEl = wrapper.querySelector(pattern.control) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

        if (controlEl && labelText) {
          // Skip if already filled, hidden, disabled, etc.
          if (this.shouldSkipElement(controlEl)) {
            return;
          }

          const options = this.extractOptions(controlEl);

          // Build question with label + entry context for Freshteam
          let question = labelText;

          // Add Freshteam employer entry context
          const employerGroup = controlEl.closest('.employer-group');
          if (employerGroup) {
            const employerContainer = employerGroup.parentElement;
            if (employerContainer) {
              const allEmployerGroups = Array.from(employerContainer.querySelectorAll('.employer-group'));
              const entryIndex = allEmployerGroups.indexOf(employerGroup as Element) + 1;
              if (entryIndex > 0) {
                question += ` [Position Entry: ${entryIndex}]`;
                printLog(`Freshteam div-based: Position Entry ${entryIndex} for "${labelText}"`);
              }
            }
          }

          // Add Freshteam education entry context
          const educationGroup = controlEl.closest('.education-group');
          if (educationGroup) {
            const educationContainer = educationGroup.parentElement;
            if (educationContainer) {
              const allEducationGroups = Array.from(educationContainer.querySelectorAll('.education-group'));
              const entryIndex = allEducationGroups.indexOf(educationGroup as Element) + 1;
              if (entryIndex > 0) {
                question += ` [Education Entry: ${entryIndex}]`;
                printLog(`Freshteam div-based: Education Entry ${entryIndex} for "${labelText}"`);
              }
            }
          }

          // Add array-indexed ID detection (Phenom/Cisco forms: experienceData[0].title, educationData[1].schoolName)
          // Also check parent fieldset IDs for nested inputs
          const elementId = controlEl.id || '';
          const fieldsetEl = controlEl.closest('fieldset');
          const fieldsetId = fieldsetEl?.id || '';
          const idToCheck = elementId || fieldsetId;

          const arrayIndexMatch = idToCheck.match(/(experience|education|employment|work|job|school)Data?\[(\d+)\]/i);
          if (arrayIndexMatch && !question.includes('[Entry:') && !question.includes('Entry:')) {
            const entryType = arrayIndexMatch[1]; // e.g., "experience", "education"
            const entryNum = parseInt(arrayIndexMatch[2]) + 1; // Convert 0-indexed to 1-indexed
            question += ` [${entryType.charAt(0).toUpperCase() + entryType.slice(1)} Entry: ${entryNum}]`;
            printLog(`Div-based array-indexed: ${entryType} Entry ${entryNum} for "${labelText}"`);
          }

          elements.push({
            element: controlEl,
            type: controlEl.type || (controlEl.tagName.toLowerCase() === 'select' ? 'select-one' : 'text'),
            tagName: controlEl.tagName.toLowerCase(),
            question,
            options
          });
        }
      });
    }

    if (elements.length > 0) {
      printLog(`Div-based elements: ${elements.length} found`);
    }
    return elements;
  }

  // Helper to check if element should be skipped
  private shouldSkipElement(input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLElement): boolean {
    const tagName = input.tagName.toLowerCase();

    // Convert to any to access properties safely
    const el = input as any;

    // Skip hidden, submit, button elements (standard inputs only)
    if (!tagName.startsWith('spl-')) {
      if (el.type === 'hidden' || el.type === 'submit' || el.type === 'button' ||
        el.type === 'reset' || el.type === 'image' || el.type === 'password' ||
        el.type === 'file') {
        return true;
      }
    }

    // Skip disabled or readonly
    if ((input as any).disabled || (input as any).readOnly) {
      return true;
    }

    // Skip hidden via CSS
    const cs = getComputedStyle(input);
    if (input.hidden || cs.display === 'none' || cs.visibility === 'hidden') {
      return true;
    }

    // Skip LinkedIn Global Nav and Search Bar (Explicit Safeguard)
    // This covers ALL search-related elements on LinkedIn, not just global nav
    const linkedInSearchBlacklist = [
      '.global-nav__content',
      '.global-nav',
      '.jobs-search-box',
      '.jobs-search-box-flyout-trigger',
      '.search-global-typeahead',
      '.reusable-search-filters',
      '.reusable-search',
      '.jobs-search-dropdown',
      '.jobs-search-results-list',
      '.search-typeahead-v2',
      '[data-chameleon-app]', // LinkedIn's dynamic search components
    ];
    for (const selector of linkedInSearchBlacklist) {
      if (input.closest(selector)) {
        printLog(`Skipping LinkedIn search element (${selector}): ${tagName}`);
        return true;
      }
    }

    // FORCE FILL MODE: Don't skip based on existing values
    // All visible, enabled elements will be filled with LLM responses

    return false;
  }

  /**
   * Returns the visible label text from an element, stripping known noise injected by some ATS platforms.
   * For example, Clinch Talent appends <span class="ada-unique-content">hex-hash</span> to every label,
   * which causes the LLM to echo the hash back as an answer.
   */
  private getCleanLabelText(element: Element): string {
    // Walk text nodes without cloneNode — exclude known ATS noise selectors.
    const skipSel = '.ada-unique-content, [data-automation-id="richText"], [data-automation-id="formFieldHelpText"], .WDGO, .gwt-HTML';
    const parts: string[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const parent = (node as Text).parentElement;
      if (parent && parent.closest(skipSel)) continue;
      const t = node.textContent?.trim();
      if (t) parts.push(t);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * When Workday/ATS wraps a short field label after a long legal/instructional paragraph,
   * keep only the trailing field label (e.g. "Signature and Date") so the LLM is not fed
   * the preamble — which otherwise gets echoed back into the input.
   */
  private sanitizeQuestionLabel(raw: string): string {
    if (!raw || raw.length < 100) return raw;

    // Preserve trailing metadata tags like [Workday ID: ...] / [Entry: N]
    const suffixMatch = raw.match(/((?:\s*\[[^\]]+\])+)\s*$/);
    const suffix = suffixMatch ? suffixMatch[1] : '';
    const body = suffix ? raw.slice(0, -suffix.length).trim() : raw.trim();
    if (body.length < 100) return raw;

    const trailingFieldPatterns = [
      /((?:Electronic\s+)?Signature(?:\s+and\s+Date)?)\s*\*?\s*$/i,
      /((?:Full\s+Legal\s+Name|Printed\s+Name|Applicant(?:'s)?\s+Name|Full\s+Name)(?:\s*\/\s*Signature)?)\s*\*?\s*$/i,
      /(Date\s+Signed|Today'?s\s+Date|Signature\s+Date)\s*\*?\s*$/i,
    ];

    for (const pattern of trailingFieldPatterns) {
      const match = body.match(pattern);
      if (match) {
        return `${match[1].replace(/\*$/, '').trim()}${suffix}`;
      }
    }

    // Generic fallback: if text ends with a short sentence/label after a long preamble, keep the tail.
    const tailMatch = body.match(/(?:^|[\.\?!])\s*([A-Z][^\.\?!]{2,60})\s*\*?\s*$/);
    if (tailMatch && body.length - tailMatch[1].length > 80) {
      return `${tailMatch[1].replace(/\*$/, '').trim()}${suffix}`;
    }

    return raw;
  }

  private extractQuestion(element: HTMLElement): string {
    // Try to find associated label
    let question = '';

    // Workday: prefer the dedicated <label> inside formField-* over parent/sibling textContent,
    // which often includes the legal/instructional rich-text sitting above the real field label.
    const workdayFieldEarly = element.closest('[data-automation-id^="formField-"]');
    if (workdayFieldEarly) {
      const wdLabel =
        workdayFieldEarly.querySelector('label') ||
        workdayFieldEarly.querySelector('[data-automation-id="formLabel"]');
      if (wdLabel) {
        const labelText = this.getCleanLabelText(wdLabel);
        if (labelText && labelText.length > 1) {
          question = labelText;
        }
      }
    }

    // Check for "label" attribute (Common in Web Components like spl-input)
    if (!question && element.hasAttribute('label')) {
      question = element.getAttribute('label') || '';
      if (question) {
        // printLog(`Found label attribute on ${element.tagName}: ${question}`);
      }
    }

    // For spl-checkbox and similar, check for slot content or inner text
    if (!question && element.tagName.toLowerCase().startsWith('spl-')) {
      // Check for slot content (e.g., <div slot="label-content">...</div>)
      const slotContent = element.querySelector('[slot="label-content"], [slot="label"]');
      if (slotContent) {
        question = slotContent.textContent?.trim() || '';
      }
      // Fallback to innerText/textContent
      if (!question) {
        question = element.textContent?.trim() || '';
      }

      // Special handling for sr-screening-questions-form fields:
      // Look for label in preceding sibling or wrapper
      if (!question) {
        const parentWrapper = element.closest('.sr-form-field, .form-field, .field-wrapper, [class*="question"]');
        if (parentWrapper) {
          // Look for label in the wrapper
          const label = parentWrapper.querySelector('label, .label, [class*="label"], .field-label');
          if (label) {
            question = this.getCleanLabelText(label);
          }
        }
        // Also check for previous label sibling
        if (!question) {
          let prev = element.previousElementSibling;
          while (prev && !question) {
            if (prev.tagName === 'LABEL' || prev.classList.contains('label') || prev.classList.contains('field-label')) {
              question = this.getCleanLabelText(prev);
              break;
            }
            prev = prev.previousElementSibling;
          }
        }
      }
    }

    // Don't return early here - we need to continue to add entry context at the end
    // if (question) return question;

    // Check for aria-labelledby (common in Greenhouse ATS forms)
    if (!question && element.hasAttribute('aria-labelledby')) {
      const labelId = element.getAttribute('aria-labelledby');
      if (labelId) {
        // Handle multiple IDs (space-separated)
        const labelIds = labelId.split(/\s+/);
        for (const id of labelIds) {
          const labelElement = document.getElementById(id);
          if (labelElement) {
            const labelText = this.getCleanLabelText(labelElement);
            // Skip placeholder labels like "Select..."
            if (labelText && !labelText.toLowerCase().includes('select...') && labelText.length > 3) {
              question = labelText;
              break;
            }
          }
        }
      }
    }

    // Check for id and associated label
    if (!question && element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) {
        question = this.getCleanLabelText(label);
      }
    }

    // Check for parent label
    if (!question) {
      const parentLabel = element.closest('label');
      if (parentLabel) {
        question = this.getCleanLabelText(parentLabel);
      }
    }

    // Check for fieldset legend (common in listboxes/radio groups)
    if (!question) {
      const fieldset = element.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) {
          question = this.getCleanLabelText(legend);
        }
      }
    }

    // --- HIRIST / GENERIC QUESTION-TEXT CONTAINER ---
    // Pattern: field lives inside a per-question wrapper (e.g. hirist's
    // `.short-answer-question-container`, `.single-answer-question-container`)
    // that contains a sibling `.question-text` / `.mandatory-question` node
    // holding the real label. Must run BEFORE the GEM sibling walker below,
    // otherwise that walker grabs the PREVIOUS question's container text and
    // every label gets shifted by one field.
    if (!question) {
      const fieldContainer = element.closest(
        '.short-answer-question-container, .single-answer-question-container, .multiple-answer-question-container'
      );
      if (fieldContainer) {
        const qt = fieldContainer.querySelector('.question-text, .mandatory-question');
        if (qt) {
          question = this.getCleanLabelText(qt);
        }
      }
    }

    // --- GEM / GENERIC SIBLING LABEL SUPPORT ---
    // Handles forms where the label is a sibling of the input's container (e.g. Gem forms)
    // Structure: Container -> Span (Label) + Div (Input Wrapper) -> Input
    if (!question) {
      let current = element.parentElement;
      // Go up up to 5 levels to find a container that shares a parent with the label
      for (let i = 0; i < 5 && current; i++) {
        const parent = current.parentElement;
        if (parent) {
          // Look for a preceding sibling of 'current' that looks like a label
          // Gem uses spans, often with classes like "bodyImportant-..."
          let sibling = current.previousElementSibling;
          while (sibling) {
            const tag = sibling.tagName;
            if (tag === 'SPAN' || tag === 'LABEL' || tag === 'DIV') {
              const text = this.getCleanLabelText(sibling);
              // Heuristic: Label shouldn't be too long, must have some text
              if (text && text.length > 2 && text.length < 100) {
                // Avoid irrelevant siblings
                if (!text.toLowerCase().includes('required') || text.length > 10) {
                  // Clean up asterisks if detached
                  question = text.replace(/\*$/, '').trim();
                  break;
                }
              }
            }
            sibling = sibling.previousElementSibling;
          }
        }
        if (question) break;
        current = parent;
      }
    }

    // Check for aria-label (but ignore generic "Select One" labels)
    if (!question) {
      const ariaLabel = element.getAttribute('aria-label') || '';
      const genericLabels = ['select one', 'choose', 'select option', 'required', 'select', 'type your response', 'enter value'];
      const isGeneric = genericLabels.some(l => ariaLabel.toLowerCase().includes(l));

      if (ariaLabel && !isGeneric) {
        question = ariaLabel;
      }
    }

    // 0. Check DIRECT PREVIOUS SIBLING (Common for h3/h4/div labels + input pattern)
    // This fixes cases where inputs are siblings to their headers (e.g. <h3 class="polygot">Name</h3><input>)
    if (!question) {
      const prev = element.previousElementSibling;
      if (prev && ['LABEL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SPAN', 'DIV', 'P'].includes(prev.tagName)) {
        // Skip typically non-label elements (dividers, error containers)
        const className = prev.className.toLowerCase();
        const isIgnored = className.includes('divider') ||
          className.includes('error') ||
          className.includes('clear') ||
          (prev.textContent || '').trim().length === 0;

        if (!isIgnored) {
          const siblingText = this.getCleanLabelText(prev);
          // Ignore long instructional/legal blocks sitting above the real field label
          if (siblingText && siblingText.length <= 120) {
            question = siblingText;
          }
          // printLog(`Found label via previous sibling ${prev.tagName}: ${question}`);
        }
      }
    }

    // Check for nearby text using more aggressive upward traversal (fixing "Type your response" issue)
    // Common ATS patterns: Greenhouse (.application-question), Lever, etc.
    if (!question) {
      // 1. Check specific known patterns (Greenhouse, Freshteam, etc.)
      // NOTE: In Freshteam, inputs themselves have class="form-group", so we must
      // start from parentElement to find the actual wrapper div
      let wrapperSearchStart: Element | null = element;
      if (element.classList.contains('form-group') || element.classList.contains('form-control')) {
        wrapperSearchStart = element.parentElement;
      }
      const formGroupWrapper = wrapperSearchStart?.closest('.application-question, .field, .form-group, .form-item, tr');
      if (formGroupWrapper) {
        const potentialLabel = formGroupWrapper.querySelector('.application-label, .label, .field-label, label, .text, th');
        if (potentialLabel) {
          // Ensure this label isn't for another input (basic check)
          question = this.getCleanLabelText(potentialLabel);
        }
      }

      // 2. Generic sibling check (if input is in a wrapper like div.application-field)
      if (!question) {
        const parent = element.parentElement;
        if (parent) {
          // Check previous sibling of parent (often the label container)
          const prevSibling = parent.previousElementSibling;
          if (prevSibling && (prevSibling.className.includes('label') || prevSibling.className.includes('text'))) {
            question = this.getCleanLabelText(prevSibling);
          }
        }
      }
    }

    // Check for name attribute
    // Special handling for Freshteam nested names like "applicant[lead_attributes[first_name]]"
    if (!question) {
      const nameAttr = element.getAttribute('name') || '';
      if (nameAttr) {
        // Try to extract meaningful field name from Freshteam's bracket notation
        // Pattern: applicant[lead_attributes[field_name]] or applicant[lead_attributes][section_attributes][][field]
        const freshteamMatch = nameAttr.match(/\[([^\[\]]+)\](?:\[\])?$/);
        if (freshteamMatch) {
          // Extract the last bracketed value (the actual field name)
          const fieldName = freshteamMatch[1];
          // Humanize: first_name -> First Name, school_name -> School Name
          question = fieldName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
          // printLog(`Freshteam field extracted: ${fieldName} -> ${question}`);
        } else {
          question = nameAttr;
        }
      }
    }

    // CHECK PLACEHOLDER LAST (Fallback)
    // Only use if we haven't found a real label, as placeholders are often generic "Type answer here"
    if (!question && 'placeholder' in element) {
      question = (element as HTMLInputElement).placeholder || '';
    }

    // --- WORKDAY SPECIAL HANDLING ---
    // Workday uses consistent data-automation-id attributes (e.g., "formField-experience")
    // We append this specific ID to the question to give the LLM 100% confidence about the field's purpose.
    const workdayContainer = element.closest('[data-automation-id^="formField-"]');
    if (workdayContainer) {
      const workdayId = workdayContainer.getAttribute('data-automation-id');
      if (workdayId) {
        // Append invisible, strong hint for LLM
        question += ` [Workday ID: ${workdayId}]`;
      }
    } else {
      // Sometimes the element itself has it (e.g. date inputs)
      const selfId = element.getAttribute('data-automation-id');
      if (selfId) {
        question += ` [Workday ID: ${selfId}]`;
      }
    }

    // Workday Date Spinbutton Disambiguation
    // Ensure the LLM knows if it's filling the "Month" or "Year" part of a date
    if (element.getAttribute('role') === 'spinbutton') {
      const ariaLabel = element.getAttribute('aria-label');
      if (ariaLabel === 'Month' || ariaLabel === 'Year') {
        if (!question.toLowerCase().includes(ariaLabel.toLowerCase())) {
          question += ` - ${ariaLabel}`;
        }
      }
    }

    // --- SUCCESSFACTORS / GENERIC REPEATER HANDLING ---
    // Detects entry numbers in repeating sections (e.g. Work Experience, Education)
    // Supports multiple patterns:
    // - SuccessFactors: "Row number 1"
    // - Workday: "Work Experience 1", "Education 1", etc.
    // - Array-indexed IDs: experienceData[0].title, educationData[1].school
    let rowText = '';
    let entryType = ''; // To track what type of entry this is (experience, education, etc.)

    // Method 0: Check for array-indexed element IDs/names
    //   - Phenom/Cisco: experienceData[0].title, educationData[1].schoolName (id)
    //   - Keka:         ExperienceDetails[0].companyName, EducationDetails[1].degree (name)
    //   - Generic:      experience[0], education[2]
    // We check both `id` and `name` so Keka-style forms (which only carry the index in `name`)
    // still get the entry context appended to the question.
    const elementId = element.id || '';
    const elementName = element.getAttribute('name') || '';
    const arrayIndexRegex = /(experience|education|employment|work|job|school)(?:Data|Details)?\[(\d+)\]/i;
    const arrayIndexMatch = elementId.match(arrayIndexRegex) || elementName.match(arrayIndexRegex);
    if (arrayIndexMatch) {
      entryType = arrayIndexMatch[1]; // e.g., "experience", "education"
      const entryNum = parseInt(arrayIndexMatch[2]) + 1; // Convert 0-indexed to 1-indexed
      question += ` [${entryType.charAt(0).toUpperCase() + entryType.slice(1)} Entry: ${entryNum}]`;
      printLog(`Context added: ${entryType} Entry ${entryNum} from array-indexed id/name`);
    }

    // Only do other detection if we didn't find an array index
    if (!arrayIndexMatch) {
      const rowHeader = element.closest('.rcmSectionComponent')?.previousElementSibling; // SuccessFactors pattern
      if (rowHeader && rowHeader.textContent?.includes('Row number')) {
        rowText = rowHeader.textContent.trim();
      } else {
        // Method 1: Use aria-labelledby or aria-label (most reliable for Workday)
        let current = element.parentElement;
        for (let i = 0; i < 20 && current && !rowText; i++) {
          const labelId = current.getAttribute('aria-labelledby');
          if (labelId) {
            const labelElement = document.getElementById(labelId);
            if (labelElement) {
              const labelText = this.getCleanLabelText(labelElement);
              const workdayMatch = labelText.match(/(Work Experience|Professional Experience|Education|Employment|Position|Job|School)\s+(\d+)/i);
              if (workdayMatch) {
                rowText = labelText;
                printLog(`Found Workday section via aria-labelledby: ${rowText}`);
                break;
              }
            }
          }
          
          // Also check aria-label directly on the container (common in newer Workday UI)
          const ariaLabel = current.getAttribute('aria-label');
          if (ariaLabel) {
            const workdayMatch = ariaLabel.match(/(Work Experience|Professional Experience|Education|Employment|Position|Job|School)\s+(\d+)/i);
            if (workdayMatch) {
              rowText = ariaLabel;
              printLog(`Found Workday section via aria-label: ${rowText}`);
              break;
            }
          }
          
          current = current.parentElement;
        }

        // Method 2: Check text content (fallback)
        if (!rowText) {
          current = element.parentElement;
          for (let i = 0; i < 15 && current; i++) {
            const textContent = current.textContent || '';

            // Workday patterns: "Work Experience 1", "Education 1", "Position 1", etc.
            const workdayMatch = textContent.match(/(Work Experience|Professional Experience|Education|Employment|Position|Job|School)\s+(\d+)/i);
            if (workdayMatch && textContent.length < 100) { // Ensure it's a label, not full description

              rowText = workdayMatch[0].trim(); // e.g., "Work Experience 1"
              printLog(`Found Workday section: ${rowText}`);
              break;
            }

            // SuccessFactors/Generic: "Row number X"
            const rowSpan = current.querySelector('.rowNumTextAcc') || current.previousElementSibling;
            if (rowSpan && rowSpan.textContent?.includes('Row number')) {
              rowText = rowSpan.textContent.trim();
              break;
            }

            current = current.parentElement;
          }
        }
      }
    }

    if (rowText) {
      // Normalize with section type so Education dates are not filled from experience_details
      let match = rowText.match(/Row number\s*(\d+)/i);
      if (match) {
        const entryNum = match[1];
        question += ` [Entry: ${entryNum}]`;
        printLog(`Context added: Entry ${entryNum} for field (Row number)`);
      } else {
        match = rowText.match(/(Work Experience|Professional Experience|Education|Employment|Position|Job|School)\s+(\d+)/i);
        if (match) {
          const section = match[1];
          const entryNum = match[2];
          const isEdu = /education|school/i.test(section);
          const typed = isEdu ? `Education Entry: ${entryNum}` : `Position Entry: ${entryNum}`;
          question += ` [${typed}] [Entry: ${entryNum}]`;
          printLog(`Context added: ${typed} for field (${section})`);
        } else {
          question += ` [${rowText}]`;
        }
      }
    }
    // --------------------------------
    // --------------------------------
    // --- FRESHTEAM EMPLOYER/EDUCATION ENTRY HANDLING ---
    // Detects dynamically added employer and education entries in Freshteam forms
    // Each employer-group or education-group is a repeating section
    if (!rowText) {
      // Check if element is inside an employer-group
      const employerGroup = element.closest('.employer-group');
      if (employerGroup) {
        // Find parent container that holds all employer groups
        const employerContainer = employerGroup.parentElement;
        if (employerContainer) {
          const allEmployerGroups = Array.from(employerContainer.querySelectorAll('.employer-group'));
          const entryIndex = allEmployerGroups.indexOf(employerGroup as Element) + 1;
          if (entryIndex > 0) {
            question += ` [Position Entry: ${entryIndex}]`;
            printLog(`Freshteam context added: Position Entry ${entryIndex}`);
          }
        }
      }

      // Check if element is inside an education-group
      const educationGroup = element.closest('.education-group');
      if (educationGroup) {
        // Find parent container that holds all education groups
        const educationContainer = educationGroup.parentElement;
        if (educationContainer) {
          const allEducationGroups = Array.from(educationContainer.querySelectorAll('.education-group'));
          const entryIndex = allEducationGroups.indexOf(educationGroup as Element) + 1;
          if (entryIndex > 0) {
            question += ` [Education Entry: ${entryIndex}]`;
            printLog(`Freshteam context added: Education Entry ${entryIndex}`);
          }
        }
      }
    }

    // --- GENERIC REPEATER DETECTION (e.g. Breezy HR, Workable, etc.) ---
    // Looks for elements inside repeating list items or divs.
    // Note: Freshteam logic above appends directly to `question` without
    // setting rowText, so this still runs after it — the `[Position/Education
    // Entry:` guard further down prevents double-tagging in that case.
    if (!rowText) {
      // 1. Find the closest "repeater item" candidate
      // We look for LI elements, role="listitem", or DIVs with specific classes that suggest repetition
      const repeaterItem = element.closest('li, [role="listitem"], .experience, .education, .employment, .position, .job, .school, .repeater-item, [ng-repeat]');

      if (repeaterItem && repeaterItem.parentElement) {
        // Check if this item has siblings of the same tag/class structure
        const siblings = Array.from(repeaterItem.parentElement.children).filter(child => {
          // Match tag name
          if (child.tagName !== repeaterItem.tagName) return false;
          // If it's a div, ensure it has similar classes (simple heuristic)
          if (child.tagName === 'DIV' && child.className !== repeaterItem.className) return false;
          // Exclude irrelevant elements (like breaks or hidden inputs if they appear as siblings)
          return child.clientHeight > 0 || child.tagName === 'LI' || child.getAttribute('role') === 'listitem';
        });

        // Only treat as repeater if there are multiple similar items OR if it's an ng-repeat/li structure 
        // that clearly looks like a list (even if size is 1 currently, it MIGHT be a list).
        // For safety, we often want to be sure it's a "section" repeater. 
        // Let's assume if it's an LI inside a UL/OL, it's a list item.

        const isList = repeaterItem.tagName === 'LI' || repeaterItem.getAttribute('role') === 'listitem';
        const hassiblings = siblings.length > 0; // It's always >0 because it includes itself

        if (isList || hassiblings) {
          const index = siblings.indexOf(repeaterItem as Element);
          if (index >= 0) {
            const entryNum = index + 1;

            // Check if we already have an Entry tag (e.g. from Freshteam logic)
            if (!question.includes('[Position Entry:') && !question.includes('[Education Entry:')) {
              // NOW: Determine the CONTEXT (Experience vs Education)
              // Walk up from the container to find a Header
              let sectionType = '';
              let current: HTMLElement | null = repeaterItem.parentElement; // Fix: Explicit type
              for (let i = 0; i < 5 && current; i++) {
                // Check previous siblings for Header
                let prev = current.previousElementSibling;
                while (prev) {
                  const combinedText = (prev.textContent || '').toLowerCase();
                  if (combinedText.includes('experience') || combinedText.includes('work history') || combinedText.includes('employment')) {
                    sectionType = 'Position';
                    break;
                  }
                  if (combinedText.includes('education') || combinedText.includes('academic') || combinedText.includes('school')) {
                    sectionType = 'Education';
                    break;
                  }
                  prev = prev.previousElementSibling;
                  // Don't go back too far
                  if (combinedText.length > 200) break;
                }
                if (sectionType) break;

                // Also check the container's own text (e.g. h3 inside the section)
                current = current.parentElement;
              }

              // If no section type found via header, try to guess from the inputs inside the item
              if (!sectionType) {
                const itemText = (repeaterItem.textContent || '').toLowerCase();
                if (itemText.includes('degree') || itemText.includes('major') || itemText.includes('school')) {
                  sectionType = 'Education';
                } else if (itemText.includes('company') && itemText.includes('title')) {
                  sectionType = 'Position';
                }
              }

              if (sectionType) {
                question += ` [${sectionType} Entry: ${entryNum}]`;
                printLog(`Generic Repeater Context: ${sectionType} Entry ${entryNum}`);
              } else if (siblings.length > 1) {
                // Even if we don't know the type, if there are multiple items, tagging them distinguishes them
                question += ` [Entry: ${entryNum}]`;
                printLog(`Generic Repeater Context: Entry ${entryNum}`);
              }
            }
          }
        }
      }
    }
    // --------------------------------
    // --------------------------------
    // --------------------------------


    // Check for nearby text
    if (!question) {
      const parent = element.parentElement;
      if (parent) {
        const textNodes = Array.from(parent.childNodes)
          .filter(node => node.nodeType === Node.TEXT_NODE)
          .map(node => node.textContent?.trim())
          .filter(text => text && text.length > 0);
        if (textNodes.length > 0) {
          question = textNodes[0] || '';
        }
      }
    }

    return this.sanitizeQuestionLabel(question || 'Form field');
  }

  private extractOptions(element: HTMLElement): string[] {
    const options: string[] = [];
    const tagName = element.tagName.toLowerCase();

    // Handle spl-radio-group - extract options from child spl-radio elements
    if (tagName === 'spl-radio-group') {
      const radioElements = element.querySelectorAll('spl-radio');
      radioElements.forEach(radio => {
        const label = radio.getAttribute('label') || radio.textContent?.trim() || '';
        if (label) {
          options.push(label);
        }
      });
      return options;
    }

    if (tagName === 'select') {
      const select = element as HTMLSelectElement;
      Array.from(select.options).forEach(option => {
        if (option.value && option.value !== '') {
          options.push(option.text || option.value);
        }
      });
    } else if (element.getAttribute('type') === 'radio' || element.getAttribute('type') === 'checkbox') {
      const name = element.getAttribute('name');
      if (name) {
        const radioButtons = document.querySelectorAll<HTMLInputElement>(`input[type="${CSS.escape(element.getAttribute('type') || '')}"][name="${CSS.escape(name)}"]`);
        radioButtons.forEach(radio => {
          const label = this.findLabelForElement(radio);
          if (label) {
            options.push(label);
          } else if (radio.value) {
            options.push(radio.value);
          }
        });
      }
    } else if (element.hasAttribute('list')) {
      const listId = element.getAttribute('list');
      if (listId) {
        const datalist = document.getElementById(listId);
        if (datalist) {
          const datalistOptions = datalist.querySelectorAll('option');
          datalistOptions.forEach(option => {
            if (option.value) {
              options.push(option.value);
            }
          });
        }
      }
    } else {
      // Try to find options via aria-controls or aria-owns (for custom listboxes)
      const controlsId = element.getAttribute('aria-controls') || element.getAttribute('aria-owns');
      if (controlsId) {
        // Handle multiple IDs if space separated
        const ids = controlsId.split(/\s+/);
        ids.forEach(id => {
          const container = document.getElementById(id);
          if (container) {
            // Try to find options with common selectors
            const foundOptions = container.querySelectorAll('[role="option"], .option, .wd-list-item, li');
            foundOptions.forEach((element) => {
              const opt = element as HTMLElement;
              // Extract text (exclude hidden/invisible only if strictly hidden)
              // Note: Some listboxes keep options in DOM but hidden until clicked.
              // We WANT to extract them for the LLM even if hidden, so it knows what to choose.
              const text = opt.textContent?.trim();
              if (text && text.length > 0) {
                options.push(text);
              }
            });
          }
        });
        if (options.length > 0) {
          printLog(`Extracted ${options.length} options via aria-controls/owns for ${this.extractQuestion(element)}`);
        }
      }
    }

    // Deduplicate options
    return [...new Set(options)];
  }

  private findLabelForElement(element: HTMLElement): string | null {
    if (element.id) {
      const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
      if (label) {
        return this.getCleanLabelText(label) || null;
      }
    }

    const parent = element.parentElement;
    if (parent && parent.tagName.toLowerCase() === 'label') {
      return this.getCleanLabelText(parent) || null;
    }

    return null;
  }

  /** True when experience_details[N].to is Present/Current/Ongoing (not empty). */
  private isCurrentExperience(entryIndex: number): boolean {
    const experience = personals?.experience_details?.[entryIndex];
    if (!experience) return false;
    const endDate = (experience.to || '').toString().toLowerCase().trim();
    return endDate === 'present' || endDate === 'current' || endDate === 'ongoing';
  }

  /**
   * Skip Workday endDate when this experience entry is current.
   * Prefer personals config over DOM checkbox state (checkbox is often filled later).
   */
  private shouldSkipWorkdayEndDate(element: HTMLElement, question?: string): boolean {
    const elemId = element.id || '';
    const q = (question || this.extractQuestion(element) || '').toLowerCase();
    const looksLikeEndDate =
      elemId.includes('--endDate') ||
      q.includes('formfield-enddate') ||
      (/\bto\b/.test(q) && (q.includes('date') || q.includes('month') || q.includes('year')));

    if (!looksLikeEndDate) return false;

    // Never skip education end dates
    if (this.isEducationSection(question || '')) return false;

    const entryIndex = this.extractEntryIndex(question || this.extractQuestion(element) || '');
    if (entryIndex !== null && this.isCurrentExperience(entryIndex)) {
      printLog(`⏭ Skipping endDate [Entry: ${entryIndex + 1}] (profile to=Present)`);
      return true;
    }

    // Fallback: DOM checkbox already checked
    if (elemId.includes('--endDate')) {
      const entryPrefix = elemId.split('--')[0];
      const cwh = document.getElementById(`${entryPrefix}--currentlyWorkHere`) as HTMLInputElement | null;
      if (cwh?.checked) {
        printLog(`⏭ Skipping endDate for ${entryPrefix} (currently work here checked)`);
        return true;
      }
    }
    return false;
  }

  /**
   * Format experience/education date from personals into MM/YYYY.
   * Returns null for Present/Current (caller should skip end-date / check currently-work-here).
   */
  private formatProfileDate(raw: string | undefined | null): string | null {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const lower = s.toLowerCase();
    if (lower === 'present' || lower === 'current' || lower === 'ongoing') {
      return null;
    }

    // MM-YYYY or MM/YYYY
    let m = s.match(/^(\d{1,2})[-/](\d{4})$/);
    if (m) return `${m[1].padStart(2, '0')}/${m[2]}`;

    // YYYY-MM or YYYY/MM
    m = s.match(/^(\d{4})[-/](\d{1,2})$/);
    if (m) return `${m[2].padStart(2, '0')}/${m[1]}`;

    // YYYY only
    m = s.match(/^(\d{4})$/);
    if (m) return `01/${m[1]}`;

    // MM/DD/YYYY or YYYY-MM-DD
    m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
    if (m) return `${m[1].padStart(2, '0')}/${m[3]}`;
    m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    if (m) return `${m[2].padStart(2, '0')}/${m[1]}`;

    return s;
  }

  private extractEntryIndex(question: string): number | null {
    const entryMatch =
      question.match(/\[(?:Position|Education)\s+Entry:\s*(\d+)\]/i) ||
      question.match(/\[Entry:\s*(\d+)\]/i) ||
      question.match(/(?:position|education)\s+entry[:\s]*(\d+)/i) ||
      question.match(/entry[:\s]*(\d+)/i);
    if (!entryMatch) return null;
    const idx = parseInt(entryMatch[1], 10) - 1;
    return Number.isFinite(idx) && idx >= 0 ? idx : null;
  }

  private isEducationSection(question: string): boolean {
    const q = (question || '').toLowerCase();
    if (/\[education\s+entry:/i.test(question)) return true;
    if (/\[position\s+entry:/i.test(question)) return false;
    return (
      q.includes('education') ||
      q.includes('formfield-school') ||
      q.includes('formfield-degree') ||
      q.includes('formfield-fieldofstudy') ||
      q.includes('school or university') ||
      q.includes('field of study')
    );
  }

  /** Race/veteran/disability/gender/orientation/religion/citizenship-class fields — see H3. */
  private isSensitiveField(question: string): boolean {
    return /\b(race|ethnicit\w*|veteran|disab\w*|gender|sex(ual)?|religio\w*|orientation|citizenship)\b/i.test(question || '');
  }

  private isExperienceSection(question: string): boolean {
    const q = (question || '').toLowerCase();
    if (/\[position\s+entry:/i.test(question)) return true;
    if (/\[education\s+entry:/i.test(question)) return false;
    return (
      q.includes('professional experience') ||
      q.includes('work experience') ||
      q.includes('formfield-jobtitle') ||
      q.includes('formfield-companyname') ||
      q.includes('formfield-roledescription') ||
      q.includes('formfield-currentlyworkhere') ||
      q.includes('role description') ||
      q.includes('job title')
    );
  }

  /**
   * Deterministic answer for signature / printed-name fields.
   * Workday often prefixes these with a long legal paragraph; use personals name
   * instead of letting the LLM echo the disclosure text.
   */
  private getSignatureAnswer(question: string): string | null {
    const q = (question || '').toLowerCase();
    const cleaned = q.replace(/\s*\[[^\]]+\]\s*/g, ' ').replace(/\*/g, '').trim();

    const isSignatureAndDate = /\bsignature\s+and\s+date\b/.test(q);
    // Prefer short, explicit labels — long legal preambles can mention "signature" without being a name field.
    const isPlainSignature =
      /^(electronic\s+)?signature$/.test(cleaned) ||
      /^(your\s+)?signature$/.test(cleaned) ||
      (cleaned.length < 80 && /\b(your\s+)?signature\b/.test(cleaned)) ||
      /\bprinted\s+name\b/.test(cleaned) ||
      /\bfull\s+legal\s+name\b/.test(cleaned);

    // Consent/agree checkboxes that merely mention "electronic signature" are not name fields.
    const isConsentOnly =
      /\b(agree|consent|acknowledge|authorize|understand|certify)\b/.test(q) &&
      !isSignatureAndDate &&
      !/\b(printed\s+name|full\s+legal\s+name|signature\s+and\s+date)\b/.test(q);

    if (isConsentOnly || (!isSignatureAndDate && !isPlainSignature)) {
      return null;
    }

    const first = String(personals?.first_name || '').trim();
    const middle = String(personals?.middle_name || '').trim();
    const last = String(personals?.last_name || '').trim();
    const fullName = [first, middle, last].filter(Boolean).join(' ');
    if (!fullName) return null;

    if (isSignatureAndDate || /\bdate\b/.test(cleaned)) {
      const today = new Date();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const yyyy = today.getFullYear();
      const signed = `${fullName} ${mm}/${dd}/${yyyy}`;
      printLog(`✓ Config → Signature/Date: ${signed}`);
      return signed;
    }

    printLog(`✓ Config → Signature: ${fullName}`);
    return fullName;
  }

  /**
   * Deterministic answers for Workday/ATS repeating Experience & Education fields.
   * Reads ONLY personals.experience_details / education_details — never LLM examples.
   */
  private getStructuredEntryAnswer(question: string): string | null {
    const q = (question || '').toLowerCase();
    const entryIndex = this.extractEntryIndex(question);
    const isEdu = this.isEducationSection(question);
    const isExp = this.isExperienceSection(question) || (
      !isEdu && entryIndex !== null && (
        q.includes('formfield-location') ||
        q.includes('formfield-startdate') ||
        q.includes('formfield-enddate') ||
        q.includes('company') ||
        q.includes('employer') ||
        ((q.includes('from') || q.includes('to') || q.includes('start') || q.includes('end')) && entryIndex !== null)
      )
    );

    // Role description — require an Entry index (do not default to job 1)
    const isRoleDescription =
      q.includes('role description') ||
      q.includes('formfield-roledescription') ||
      q.includes('role summary') ||
      (entryIndex !== null && !isEdu && (
        q.includes('job description') ||
        q.includes('responsibilities')
      ));

    if (isRoleDescription) {
      if (entryIndex === null) return null;
      const experience = personals?.experience_details?.[entryIndex];
      if (!experience?.highlights?.length) return null;
      const description = experience.highlights
        .map((h) => {
          const text = String(h).trim();
          if (!text) return '';
          return /^[-•*]/.test(text) ? text : `• ${text}`;
        })
        .filter(Boolean)
        .join('\n');
      if (!description) return null;
      printLog(`✓ Config highlights → Role Description [Entry: ${entryIndex + 1}] (${experience.highlights.length} bullets, ${experience.companyKey})`);
      return description;
    }

    if (entryIndex === null) return null;

    // Education structured fields (checked first when tagged Education)
    if (isEdu) {
      const education = personals?.education_details?.[entryIndex];
      if (!education) {
        printLog(`⚠ No education_details[${entryIndex}] in personals config`);
        return null;
      }

      if (q.includes('school') || q.includes('university') || q.includes('institution') || q.includes('formfield-school') || q.includes('college')) {
        printLog(`✓ Config → School [Entry: ${entryIndex + 1}]: ${education.institution}`);
        return education.institution || null;
      }
      if (q.includes('degree') || q.includes('formfield-degree')) {
        printLog(`✓ Config → Degree [Entry: ${entryIndex + 1}]: ${education.degree}`);
        return education.degree || null;
      }
      if (q.includes('field') || q.includes('major') || q.includes('formfield-fieldofstudy') || q.includes('study')) {
        printLog(`✓ Config → Field [Entry: ${entryIndex + 1}]: ${education.field}`);
        return education.field || null;
      }

      const isFrom =
        q.includes('formfield-startdate') ||
        (/\bfrom\b/.test(q) && !/\bto\b/.test(q)) ||
        (q.includes('start') && (q.includes('date') || q.includes('year') || q.includes('month')));
      const isTo =
        q.includes('formfield-enddate') ||
        (/\bto\b/.test(q) && !/\bfrom\b/.test(q)) ||
        (q.includes('end') && (q.includes('date') || q.includes('year') || q.includes('month'))) ||
        q.includes('graduation');

      if (isFrom) {
        const formatted = this.formatProfileDate(education.from);
        printLog(`✓ Config → Edu From [Entry: ${entryIndex + 1}]: ${formatted}`);
        return formatted;
      }
      if (isTo) {
        const formatted = this.formatProfileDate(education.to);
        printLog(`✓ Config → Edu To [Entry: ${entryIndex + 1}]: ${formatted}`);
        return formatted;
      }
      return null;
    }

    // Experience structured fields
    if (isExp) {
      const experience = personals?.experience_details?.[entryIndex];
      if (!experience) {
        printLog(`⚠ No experience_details[${entryIndex}] in personals config`);
        return null;
      }

      if (q.includes('job title') || q.includes('formfield-jobtitle') || (q.includes('title') && !q.includes('subtitle'))) {
        printLog(`✓ Config → Job Title [Entry: ${entryIndex + 1}]: ${experience.title}`);
        return experience.title || null;
      }
      if (q.includes('company') || q.includes('employer') || q.includes('formfield-companyname')) {
        printLog(`✓ Config → Company [Entry: ${entryIndex + 1}]: ${experience.companyKey}`);
        return experience.companyKey || null;
      }
      if (q.includes('location') || q.includes('formfield-location')) {
        printLog(`✓ Config → Location [Entry: ${entryIndex + 1}]: ${experience.location}`);
        return experience.location || null;
      }

      const isFrom =
        q.includes('formfield-startdate') ||
        (/\bfrom\b/.test(q) && !/\bto\b/.test(q)) ||
        (q.includes('start') && (q.includes('date') || q.includes('month') || q.includes('year')));
      const isTo =
        q.includes('formfield-enddate') ||
        (/\bto\b/.test(q) && !/\bfrom\b/.test(q)) ||
        (q.includes('end') && (q.includes('date') || q.includes('month') || q.includes('year')));

      if (isFrom) {
        const formatted = this.formatProfileDate(experience.from);
        printLog(`✓ Config → From [Entry: ${entryIndex + 1}]: ${formatted} (raw: ${experience.from})`);
        return formatted;
      }
      if (isTo) {
        // Present jobs: skip (null) — currently-work-here checkbox handles this
        if (this.isCurrentExperience(entryIndex)) {
          printLog(`⏭ Config → To [Entry: ${entryIndex + 1}] is Present; not filling end date`);
          return null;
        }
        const formatted = this.formatProfileDate(experience.to);
        printLog(`✓ Config → To [Entry: ${entryIndex + 1}]: ${formatted} (raw: ${experience.to})`);
        return formatted;
      }
    }

    return null;
  }

  private async fillElement(formElement: FormElement): Promise<void> {
    try {
      const { element, type, question, options } = formElement;

      // React/Workday re-renders can detach a node between detection and
      // fill. Writing to a detached element is a silent no-op — without this
      // check filledCount still increments, so the popup reports success
      // while the page shows the field empty (see H6).
      if (!element.isConnected) {
        printLog(`⚠ Skipping detached element: ${question || 'Unknown field'}`);
        return;
      }

      const enhancedQuestionEarly = this.getEnhancedQuestion(formElement);
      if (this.shouldSkipWorkdayEndDate(element, enhancedQuestionEarly)) {
        return;
      }

      printLog(`Filling element: ${question || 'Unknown field'
        }`);

      const enhancedQuestion = enhancedQuestionEarly;

      // Prefer structured personals: signature name, then Experience/Education entry fields
      let answer = this.getSignatureAnswer(enhancedQuestion) || this.getStructuredEntryAnswer(enhancedQuestion);

      if (!answer) {
        const userInfo = personals.user_information_all || undefined;
        answer = await llmManager.getAnswer(
          enhancedQuestion,
          options,
          this.determineQuestionType(type, options),
          undefined,
          userInfo
        );
      }

      if (!answer) {
        printLog(`No answer generated for: ${question} `);
        return;
      }

      // Fill the element based on type
      await this.setElementValue(element, type, answer, options);
      this.filledCount++;
      this.emitStatus();

      printLog(`✓ Filled: ${question} with: ${answer} `);
    } catch (error) {
      printLog(`Error filling element: ${error} `);
    }
  }

  // Optimized version that uses pre-cached answer.
  // allowPerFieldLlm=false in batch mode: structured + cached + fuzzy only (no LLM storm).
  private async fillElementWithAnswer(
    formElement: FormElement,
    cachedAnswer?: string,
    allowPerFieldLlm: boolean = true
  ): Promise<void> {
    try {
      const { element, type, question, options } = formElement;

      if (!element.isConnected) {
        printLog(`⚠ Skipping detached element: ${question || 'Unknown field'}`);
        return;
      }

      const enhancedQuestion = this.getEnhancedQuestion(formElement);

      if (this.shouldSkipWorkdayEndDate(element, enhancedQuestion)) {
        return;
      }

      let answer = this.getSignatureAnswer(enhancedQuestion) || this.getStructuredEntryAnswer(enhancedQuestion) || cachedAnswer;

      if (!answer && allowPerFieldLlm) {
        const userInfo = personals.user_information_all || undefined;
        const llmAnswer = await llmManager.getAnswer(
          enhancedQuestion,
          options,
          this.determineQuestionType(type, options),
          undefined,
          userInfo
        );
        answer = llmAnswer || undefined;
      } else if (!answer && !allowPerFieldLlm) {
        answer = llmManager.getFuzzyAnswerPublic(enhancedQuestion, options) || undefined;
      }

      if (!answer) {
        printLog(`No answer for: ${question} `);
        return;
      }

      await this.setElementValue(element, type, answer, options);
      this.filledCount++;
      this.emitStatus();

      printLog(`✓ Filled: ${question} with: ${answer.substring(0, 50)} `);
    } catch (error) {
      printLog(`Error filling element: ${error} `);
    }
  }

  private getEnhancedQuestion(formElement: FormElement): string {
    const { element, type, question } = formElement;
    const input = element as HTMLInputElement;
    let enhancedQuestion = question || 'Form field';

    // For date fields, detect expected format from placeholder or question context
    if (type === 'date' || type === 'text') {
      const placeholder = input.getAttribute('placeholder') || '';
      const questionLower = question?.toLowerCase() || '';

      // Word-boundary "date" check — plain substring matched "Candidate",
      // "Update", "Mandate" and wrongly tagged them as date fields (M6).
      const hasDateWord = /\bdate\b/i.test(questionLower);
      const placeholderHasDateWord = /\bdate\b/i.test(placeholder);

      // Workday-specific: Start/End dates often use MM/YYYY format
      const isWorkdayMonthYearField =
        (questionLower.includes('start') || questionLower.includes('end') ||
          questionLower.includes('from') || questionLower.includes('to')) &&
        (hasDateWord || questionLower.includes('month') ||
          (placeholder.toUpperCase().includes('MM') && !placeholder.toUpperCase().includes('DD')));

      // Check if placeholder explicitly shows MM/YYYY format (no day component)
      const isMonthYearPlaceholder = placeholder &&
        placeholder.toUpperCase().includes('MM') &&
        placeholder.toUpperCase().includes('YYYY') &&
        !placeholder.toUpperCase().includes('DD');

      if (isMonthYearPlaceholder || isWorkdayMonthYearField) {
        enhancedQuestion = `${enhancedQuestion} (format: MM/YYYY)`;
      } else if (placeholder && (
        placeholder.toUpperCase().includes('MM') ||
        placeholder.toUpperCase().includes('DD') ||
        placeholder.toUpperCase().includes('YYYY') ||
        placeholderHasDateWord
      )) {
        enhancedQuestion = `${enhancedQuestion} (format: ${placeholder})`;
      }
    }
    return enhancedQuestion;
  }

  private determineQuestionType(type: string, options?: string[]): string {
    if (type === 'radio') {
      return 'radio';
    } else if (type === 'checkbox') {
      return 'checkbox';
    } else if (type === 'select-one' || type === 'combobox' || type === 'listbox' || (type === 'select' && options && options.length > 0)) {
      return 'single_select';
    } else if (type === 'select-multiple') {
      return 'multiple_select';
    } else {
      return 'text';
    }
  }

  /**
   * Set an input/textarea value in a way React/Workday trackers notice.
   * Plain `el.value = ...` only paints the DOM; Workday still treats the field as empty.
   */
  private setReactInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    const tag = el.tagName.toLowerCase();
    const proto =
      tag === 'textarea'
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    const nativeSetter = descriptor?.set;

    try {
      el.focus();
    } catch {
      // Some Workday controls reject programmatic focus; continue anyway.
    }

    if (nativeSetter) {
      nativeSetter.call(el, value);
    } else {
      el.value = value;
    }

    // Keep ARIA spinbutton state in sync when present
    if (el.getAttribute('role') === 'spinbutton') {
      el.setAttribute('aria-valuenow', value);
      el.setAttribute('aria-valuetext', value);
    }

    el.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        cancelable: true,
        data: value,
        inputType: 'insertText',
      })
    );
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Cached once per fill run — avoid O(F) DOM scan on every Workday field. */
  private getFocusableElements(): HTMLElement[] {
    if (this.focusableCache) return this.focusableCache;
    this.focusableCache = Array.from(
      document.querySelectorAll<HTMLElement>(
        'input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )
    ).filter((node) => {
      const style = window.getComputedStyle(node);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    return this.focusableCache;
  }

  /**
   * Simulate Tab-away commit. Manually Tabbing a Workday field validates and clears
   * "required" errors even when the value was already visible.
   */
  private simulateTabCommit(el: HTMLElement): void {
    const tabInit: KeyboardEventInit = {
      key: 'Tab',
      code: 'Tab',
      keyCode: 9,
      which: 9,
      bubbles: true,
      cancelable: true,
    };

    try {
      el.focus();
    } catch {
      // ignore
    }

    el.dispatchEvent(new KeyboardEvent('keydown', tabInit));
    el.dispatchEvent(new KeyboardEvent('keyup', tabInit));

    try {
      el.blur();
    } catch {
      // ignore
    }
    el.dispatchEvent(new Event('blur', { bubbles: true }));

    const focusable = this.getFocusableElements();
    const idx = focusable.indexOf(el);
    const next = idx >= 0 ? focusable[idx + 1] : undefined;
    if (next && next !== el) {
      try {
        next.focus();
      } catch {
        // ignore
      }
    }
  }

  /** Workday-only: React-safe set + Tab commit so required validation clears. */
  private commitWorkdayFieldValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
    this.setReactInputValue(el, value);
    this.simulateTabCommit(el);
  }

  private async setElementValue(
    element: HTMLElement,
    type: string,
    value: string,
    options?: string[]
  ): Promise<void> {
    const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

    switch (type) {
      case 'password':
      case 'file':
        printLog('Skipping password/file input');
        break;
      case 'text':
      case 'email':
      case 'url':
      case 'search':
      case 'tel':
        // SPECIAL HANDLING: Workday date spinbuttons (Month/Year)
        const spinRole = input.getAttribute('role');
        const ariaLabel = input.getAttribute('aria-label') || '';

        if (spinRole === 'spinbutton' && (ariaLabel === 'Month' || ariaLabel === 'Year')) {
          // This is a Workday date spinbutton
          let month: number | null = null;
          let year: number | null = null;

          // Attempt 1: Parse as full date (ISO, MM/YYYY, etc.)
          const parsedISO = this.parseDateToISO(value);
          if (parsedISO) {
            const parts = parsedISO.split('-');
            year = parseInt(parts[0]);
            month = parseInt(parts[1]);
          } else {
            // Attempt 2: Check for MM/YYYY regex specifically
            const slashMatch = value.match(/(\d{1,2})\/(\d{4})/);
            if (slashMatch) {
              month = parseInt(slashMatch[1]);
              year = parseInt(slashMatch[2]);
            } else {
              // Attempt 3: Handle individual values (likely due to disambiguated prompt)
              const valInt = parseInt(value.replace(/[^0-9]/g, ''));
              if (!isNaN(valInt)) {
                if (ariaLabel === 'Month' && valInt >= 1 && valInt <= 12) {
                  month = valInt;
                } else if (ariaLabel === 'Year' && valInt > 0) {
                  year = valInt;
                  // Handle 2-digit years (e.g. "03" -> 2003, "99" -> 1999)
                  if (year < 100) {
                    const currentYear = new Date().getFullYear();
                    const currentCentury = Math.floor(currentYear / 100) * 100;
                    // If year + 2000 is in the future (e.g. 30 -> 2030), maybe it's 1930?
                    // But for work experience, 2030 is unlikely.
                    // Simple logic: < 50 -> 20xx, >= 50 -> 19xx
                    // Adjust as needed. Given the issue 0003, user likely meant 2003.
                    if (year < 50) {
                      year += 2000;
                    } else {
                      year += 1900;
                    }
                    printLog(`⚠ Converted 2-digit year ${valInt} to ${year}`);
                  }
                }
              }
            }
          }

          if (month !== null || year !== null) {
            // Find the parent dateInputWrapper to locate both Month and Year inputs
            const dateWrapper = input.closest('[data-automation-id="dateInputWrapper"]');

            const setSpinValue = async (el: HTMLInputElement, val: number, padMonth = false) => {
              const str = padMonth ? String(val).padStart(2, '0') : String(val);
              this.setReactInputValue(el, str);
            };

            if (dateWrapper) {
              const monthInput = dateWrapper.querySelector('[data-automation-id="dateSectionMonth-input"]') as HTMLInputElement;
              const yearInput = dateWrapper.querySelector('[data-automation-id="dateSectionYear-input"]') as HTMLInputElement;

              if (monthInput && yearInput) {
                // If we have extracted both month and year (from full date), set both
                // BUT only if we are on the Month field. If we are on the Year field,
                // setting both could overwrite a correctly filled month with a default value.
                if (month !== null && year !== null && ariaLabel !== 'Year') {
                  await setSpinValue(monthInput, month, true);
                  await sleep(getConditionalDelay(40, 120));
                  await setSpinValue(yearInput, year, false);
                  this.simulateTabCommit(yearInput);
                  printLog(`✓ Set Workday date spinbuttons (Sync): Month=${month}, Year=${year}`);
                  break; // Done
                }

                // If we only have specific parts (because LLM answered "month" or "year" question)
                if (ariaLabel === 'Month' && month !== null) {
                  await setSpinValue(monthInput, month, true);
                  this.simulateTabCommit(monthInput);
                  printLog(`✓ Set Workday Month spinbutton: ${month}`);
                  break;
                }
                if (ariaLabel === 'Year' && year !== null) {
                  await setSpinValue(yearInput, year, false);
                  this.simulateTabCommit(yearInput);
                  printLog(`✓ Set Workday Year spinbutton: ${year}`);
                  break;
                }
              }
            }

            // Fallback if no wrapper found or simple structure
            if (ariaLabel === 'Month' && month !== null) {
              await setSpinValue(input as HTMLInputElement, month, true);
              this.simulateTabCommit(input as HTMLInputElement);
              printLog(`✓ Set Month spinbutton (fallback): ${month}`);
              break;
            } else if (ariaLabel === 'Year' && year !== null) {
              await setSpinValue(input as HTMLInputElement, year, false);
              this.simulateTabCommit(input as HTMLInputElement);
              printLog(`✓ Set Year spinbutton (fallback): ${year}`);
              break;
            }
          }

          // Spinbutton path could not extract valid month/year.
          // Do NOT fall through to plain-text fill — that would dump a date string
          // into a numeric spinbutton and break the field.
          printLog(`⚠ Skipping Workday ${ariaLabel} spinbutton: could not parse "${value}" as a number`);
          break;
        }

        // Regular text input handling
        // Check for maxlength
        const maxLen = input.getAttribute('maxlength');
        let textValue = value;
        if (maxLen && parseInt(maxLen) > 0) {
          textValue = value.substring(0, parseInt(maxLen));
        }
        if (isWorkdayDomain()) {
          this.commitWorkdayFieldValue(input as HTMLInputElement | HTMLTextAreaElement, textValue);
        } else {
          input.value = textValue;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;

      case 'number':
        // Get question/placeholder to check if it's a donation/amount field
        const numQuestion = this.extractQuestion(element).toLowerCase();
        const numPlaceholder = (input.getAttribute('placeholder') || '').toLowerCase();

        // Parse and validate number, respect min/max
        let numVal = parseFloat(value.replace(/[^0-9.\-]/g, ''));

        // If parsing failed but this is a donation/amount field, use a default value
        if (isNaN(numVal)) {
          if (numQuestion.includes('donation') || numQuestion.includes('amount') ||
            numQuestion.includes('price') || numQuestion.includes('cost') ||
            numPlaceholder.includes('donation') || numPlaceholder.includes('amount')) {
            numVal = 10; // Default donation amount
            printLog(`Using default donation amount: ${numVal} `);
          } else if (numQuestion.includes('quantity') || numQuestion.includes('qty') ||
            numQuestion.includes('count') || numQuestion.includes('number of')) {
            numVal = 1; // Default quantity
            printLog(`Using default quantity: ${numVal} `);
          } else if (numQuestion.includes('age') || numQuestion.includes('years')) {
            numVal = 25; // Default age
            printLog(`Using default age: ${numVal} `);
          }
        }

        if (!isNaN(numVal)) {
          const min = input.getAttribute('min');
          const max = input.getAttribute('max');
          const step = input.getAttribute('step');

          if (min && numVal < parseFloat(min)) numVal = parseFloat(min);
          if (max && numVal > parseFloat(max)) numVal = parseFloat(max);

          // Round to step if specified
          if (step && step !== 'any') {
            const stepVal = parseFloat(step);
            numVal = Math.round(numVal / stepVal) * stepVal;
          }

          if (isWorkdayDomain()) {
            this.commitWorkdayFieldValue(input as HTMLInputElement, String(numVal));
          } else {
            input.value = String(numVal);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          printLog(`✓ Set number input to: ${numVal} `);
        } else {
          printLog(`⚠ Could not parse number from: ${value} `);
        }
        break;

      case 'date':
        // Detect expected format from placeholder or data attribute
        const datePlaceholder = (input.getAttribute('placeholder') || '').toUpperCase();
        const datePattern = input.getAttribute('data-date-format') || input.getAttribute('pattern') || '';

        // Determine the expected format
        let expectedFormat = 'YYYY-MM-DD'; // Default for HTML5 date input
        if (datePlaceholder.includes('MM') && datePlaceholder.includes('DD') && datePlaceholder.includes('YYYY')) {
          expectedFormat = datePlaceholder.replace(/[^A-Z\-\/]/g, '');
        } else if (datePattern) {
          expectedFormat = datePattern.toUpperCase();
        }

        printLog(`Date field: placeholder = "${datePlaceholder}", expectedFormat = "${expectedFormat}"`);

        // Parse the date from LLM response
        let parsedDate = this.parseDateToISO(value);
        if (parsedDate) {
          // Format according to expected format
          const [year, month, day] = parsedDate.split('-');
          let formattedDate = parsedDate;

          if (expectedFormat.startsWith('MM') && expectedFormat.includes('DD')) {
            // MM-DD-YYYY or MM/DD/YYYY
            const separator = expectedFormat.includes('/') ? '/' : '-';
            formattedDate = `${month}${separator}${day}${separator}${year}`;
          } else if (expectedFormat.startsWith('DD') && expectedFormat.includes('MM')) {
            // DD-MM-YYYY or DD/MM/YYYY
            const separator = expectedFormat.includes('/') ? '/' : '-';
            formattedDate = `${day}${separator}${month}${separator}${year}`;
          } else if (expectedFormat.startsWith('YYYY')) {
            // YYYY-MM-DD or YYYY/MM/DD
            const separator = expectedFormat.includes('/') ? '/' : '-';
            formattedDate = `${year}${separator}${month}${separator}${day}`;
          }

          // For HTML5 date inputs, always use YYYY-MM-DD regardless of placeholder
          const dateToSet = input.type === 'date' ? parsedDate : formattedDate;
          if (isWorkdayDomain()) {
            this.commitWorkdayFieldValue(input as HTMLInputElement, dateToSet);
          } else {
            input.value = dateToSet;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
          printLog(`✓ Set date to: ${(input as HTMLInputElement).value} (format: ${expectedFormat})`);
        } else {
          printLog(`⚠ Could not parse date: ${value} `);
        }
        break;

      case 'time':
        // Accept HH:MM or HH:MM:SS format
        const timeMatch = value.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (timeMatch) {
          const hours = timeMatch[1].padStart(2, '0');
          const mins = timeMatch[2];
          const secs = timeMatch[3] || '00';
          input.value = `${hours}:${mins}:${secs}`;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;

      case 'datetime-local':
      case 'month':
      case 'week':
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        break;

      case 'range':
        let rangeValue = parseFloat(value.replace(/[^0-9.\-]/g, ''));
        if (!isNaN(rangeValue)) {
          const rangeMin = parseFloat(input.getAttribute('min') || '0');
          const rangeMax = parseFloat(input.getAttribute('max') || '100');
          if (rangeValue < rangeMin) rangeValue = rangeMin;
          if (rangeValue > rangeMax) rangeValue = rangeMax;
          input.value = String(rangeValue);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;

      case 'color':
        // Accept hex colors with or without #
        let colorVal = value.trim();
        if (!colorVal.startsWith('#')) colorVal = '#' + colorVal;
        if (/^#[0-9A-F]{6}$/i.test(colorVal)) {
          input.value = colorVal;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          printLog(`⚠ Invalid color format: ${value} `);
        }
        break;

      case 'checkbox':
        // Get the checkbox label to check for terms/conditions/agreement
        const checkboxLabel = this.extractQuestion(element).toLowerCase();

        // Marketing/subscription opt-ins require explicit user consent — never
        // auto-check them even though their labels often also contain
        // "consent"/"confirm"/"agree" (e.g. "I consent to receive marketing
        // communications"). This guard used to be a comment only, with no
        // code behind it — the checkbox below actually got auto-checked.
        const isMarketingOptIn =
          /\b(newsletter|marketing|promotional|subscribe|sms|text\s+alerts?|job\s+alerts?)\b/i.test(checkboxLabel);

        // Auto-check if this is a terms/conditions/agreement checkbox.
        const isTermsCheckbox =
          !isMarketingOptIn && (
            checkboxLabel.includes('agree') ||
            checkboxLabel.includes('accept') ||
            checkboxLabel.includes('terms') ||
            checkboxLabel.includes('conditions') ||
            checkboxLabel.includes('privacy') ||
            checkboxLabel.includes('policy') ||
            checkboxLabel.includes('read and') ||
            checkboxLabel.includes('i have read') ||
            checkboxLabel.includes('consent') ||
            checkboxLabel.includes('confirm') ||
            checkboxLabel.includes('acknowledge')
          );

        // Special handling for "I currently work here" checkbox
        const isCurrentlyWorkHereCheckbox =
          checkboxLabel.includes('currently work here') ||
          checkboxLabel.includes('current position') ||
          checkboxLabel.includes('present employer') ||
          checkboxLabel.includes('still working');

        // For "currently work here", check if the experience entry is current (ends with Present)
        let shouldCheckCurrentWork = false;
        if (isCurrentlyWorkHereCheckbox && personals?.experience_details) {
          // Get entry index from label context if available, e.g., "[Entry: 1]"
          const entryMatch = checkboxLabel.match(/entry[:\s]*(\d+)/i);
          const entryIndex = entryMatch ? parseInt(entryMatch[1], 10) - 1 : 0;
          const experience = personals.experience_details[entryIndex];
          if (experience) {
            const endDate = (experience.to || '').toString().toLowerCase().trim();
            // Only explicit present markers — empty to must NOT imply current job
            if (endDate === 'present' || endDate === 'current' || endDate === 'ongoing') {
              shouldCheckCurrentWork = true;
              printLog(`✓ Entry ${entryIndex + 1} is current position (to: "${experience.to}"), will check "currently work here"`);
            }
          }
        }

        // For checkboxes, check if value matches positive responses OR if it's a terms checkbox
        const checkValue = value.toLowerCase().trim();
        const shouldCheck = isTermsCheckbox || shouldCheckCurrentWork ||
          checkValue === 'yes' || checkValue === 'true' ||
          checkValue === '1' || checkValue === 'on' ||
          checkValue === 'checked' || checkValue === 'agree' ||
          checkValue === 'accept';

        printLog(`Checkbox: label = "${checkboxLabel.substring(0, 50)}...", isTerms = ${isTermsCheckbox}, value = "${value}", shouldCheck = ${shouldCheck} `);
        if (shouldCheck) {
          const tagNameLower = element.tagName.toLowerCase();
          if (tagNameLower === 'spl-checkbox') {
            // SmartRecruiters custom checkbox - set value attribute and click
            element.setAttribute('value', 'true');
            element.setAttribute('checked', '');
            element.click(); // Trigger the component's internal click handler
            element.dispatchEvent(new Event('change', { bubbles: true }));
            printLog(`✓ Checked spl-checkbox${isTermsCheckbox ? ' (auto-checked terms/conditions)' : ''} `);
          } else {
            const checkbox = input as HTMLInputElement;
            checkbox.checked = true;
            checkbox.dispatchEvent(new Event('change', { bubbles: true }));
            checkbox.dispatchEvent(new Event('click', { bubbles: true }));
            checkbox.dispatchEvent(new Event('input', { bubbles: true }));
            printLog(`✓ Checked checkbox${isTermsCheckbox ? ' (auto-checked terms/conditions)' : ''} `);
          }
        } else if (isCurrentlyWorkHereCheckbox && (input as HTMLInputElement).checked) {
          // Profile says this entry has ended — clear a pre-checked box so the
          // real end date gets filled instead of being skipped by
          // shouldSkipWorkdayEndDate's "currently work here" DOM fallback.
          const checkbox = input as HTMLInputElement;
          checkbox.checked = false;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          checkbox.dispatchEvent(new Event('click', { bubbles: true }));
          checkbox.dispatchEvent(new Event('input', { bubbles: true }));
          printLog(`✓ Unchecked "currently work here" (profile entry has an end date)`);
        }
        break;

      case 'spl-radio-group':
        // Handle SmartRecruiters spl-radio-group element
        // Find the matching spl-radio child and click it
        const splRadioGroup = element as HTMLElement;
        const splRadios = splRadioGroup.querySelectorAll('spl-radio');
        const targetValueLower = value.toLowerCase().trim();

        printLog(`SPL Radio Group: looking for "${value}" in ${splRadios.length} options`);

        let foundSplRadio = false;
        splRadios.forEach((radio) => {
          if (foundSplRadio) return;

          const radioLabel = (radio.getAttribute('label') || radio.textContent || '').trim();
          const radioValue = radio.getAttribute('value') || '';
          const labelLower = radioLabel.toLowerCase();

          // Check for match
          const isMatch =
            labelLower === targetValueLower ||
            radioValue === value ||
            (targetValueLower === 'yes' && (labelLower === 'yes' || radioValue === '1' || radioValue === 'true')) ||
            (targetValueLower === 'no' && (labelLower === 'no' || radioValue === '0' || radioValue === 'false'));

          if (isMatch) {
            (radio as HTMLElement).setAttribute('checked', '');
            (radio as HTMLElement).setAttribute('aria-checked', 'true');
            (radio as HTMLElement).click();
            radio.dispatchEvent(new Event('change', { bubbles: true }));
            printLog(`✓ Selected spl-radio-group option: "${radioLabel}"`);
            foundSplRadio = true;
          }
        });

        if (!foundSplRadio) {
          printLog(`⚠ No matching spl-radio-group option found for: ${value}`);
        }
        break;

      case 'radio':
        // SPECIAL HANDLING: spl-radio (SmartRecruiters custom web component)
        if (element.tagName.toLowerCase() === 'spl-radio') {
          const optionText = (element.querySelector('[slot="label"], [slot="label-content"]')?.textContent || element.textContent || '').trim();
          const optionValue = element.getAttribute('value') || '';

          printLog(`Checking spl-radio: option="${optionText}", value="${optionValue}" vs target="${value}"`);

          const isMatch =
            (!!optionText && textualMatch(value, optionText)) ||
            (optionValue && value === optionValue) ||
            (value.toLowerCase() === 'yes' && (optionText.toLowerCase() === 'yes' || optionValue === '1' || optionValue === 'true')) ||
            (value.toLowerCase() === 'no' && (optionText.toLowerCase() === 'no' || optionValue === '0' || optionValue === 'false'));

          if (isMatch) {
            element.setAttribute('checked', '');
            element.setAttribute('aria-checked', 'true');
            element.click();
            element.dispatchEvent(new Event('change', { bubbles: true }));
            printLog(`✓ Selected spl-radio: "${optionText}"`);
            return; // Done for this element
          }
          // If strictly no match, we just don't click it. 
          // Since we iterate all radios, the correct one will be clicked eventually.
          break;
        }

        // Find matching radio button by matching value to options
        printLog(`Radio: looking for "${value}" in options: ${JSON.stringify(options)} `);
        const name = input.getAttribute('name');
        if (name) {
          const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${CSS.escape(name)}"]`);
          const valLowerRadio = value.toLowerCase().trim();

          let foundRadio = false;
          radios.forEach((radio, idx) => {
            if (foundRadio) return; // Already found one

            const radioLabel = this.findLabelForElement(radio) || radio.value;
            const labelLower = radioLabel.toLowerCase().trim();
            const radioValueLower = radio.value.toLowerCase().trim();

            // Skip empty options
            if (!labelLower && !radioValueLower) return;

            // Check for exact match first
            if (labelLower === valLowerRadio || radioValueLower === valLowerRadio) {
              radio.checked = true;
              radio.dispatchEvent(new Event('change', { bubbles: true }));
              radio.dispatchEvent(new Event('click', { bubbles: true }));
              radio.dispatchEvent(new Event('input', { bubbles: true }));
              printLog(`✓ Selected radio option ${idx} (exact): "${radioLabel}"`);
              foundRadio = true;
              return;
            }

            // Whole-word partial match (see H1: plain substring containment
            // matches "male" inside "female" and picks the wrong option).
            if (textualMatch(valLowerRadio, labelLower)) {
              radio.checked = true;
              radio.dispatchEvent(new Event('change', { bubbles: true }));
              radio.dispatchEvent(new Event('click', { bubbles: true }));
              radio.dispatchEvent(new Event('input', { bubbles: true }));
              printLog(`✓ Selected radio option ${idx} (partial): "${radioLabel}"`);
              foundRadio = true;
              return;
            }

            // Check value partial match
            if (textualMatch(valLowerRadio, radioValueLower)) {
              radio.checked = true;
              radio.dispatchEvent(new Event('change', { bubbles: true }));
              radio.dispatchEvent(new Event('click', { bubbles: true }));
              radio.dispatchEvent(new Event('input', { bubbles: true }));
              printLog(`✓ Selected radio option ${idx} (value match): "${radioLabel}"`);
              foundRadio = true;
            }
          });

          if (!foundRadio) {
            printLog(`⚠ No matching radio option found for: ${value} `);
          }
        }
        break;

      case 'select-one':
      case 'select':
        const select = input as HTMLSelectElement;
        printLog(`Setting select value to: ${value}, has ${select.options.length} options`);

        // Try to find matching option (case insensitive, partial match)
        let matchingOptionIndex = -1;
        const valLower = value.toLowerCase().trim();

        for (let i = 0; i < select.options.length; i++) {
          const opt = select.options[i];
          const optText = opt.text.toLowerCase().trim();
          const optValue = opt.value.toLowerCase().trim();
          const optId = (opt.id || '').toLowerCase().trim();
          const optLabel = (opt.label || '').toLowerCase().trim();
          const optDataValue = (opt.getAttribute('data-value') || '').toLowerCase().trim();

          // Skip placeholder options — do NOT include '0' here because Greenhouse
          // uses value="0" for the "No" option in Yes/No dropdowns.
          const isPlaceholderOpt = optValue === '' || optValue === 'none' || optValue === 'null' ||
            optValue === 'select' || optValue === '-1' ||
            optText === '' ||
            optText.includes('select') || optText.includes('choose') ||
            optText.includes('option') || optText.includes('please');

          if (isPlaceholderOpt) {
            continue;
          }

          // Check for exact match on any attribute (most reliable)
          if (optText === valLower || optValue === valLower ||
            optId === valLower || optLabel === valLower || optDataValue === valLower) {
            matchingOptionIndex = i;
            printLog(`Found exact match at index ${i}: "${opt.text}"(value: "${opt.value}")`);
            break;
          }

          // Check for whole-word partial match on visible text. Plain
          // bidirectional substring containment matches "male" inside
          // "female" and silently selects the wrong option — see H1. Value/id/
          // label checks below intentionally stay plain-substring (length>=2)
          // to keep supporting short codes like "IN" for "India".
          if (textualMatch(valLower, optText)) {
            matchingOptionIndex = i;
            printLog(`Found text match at index ${i}: "${opt.text}"(value: "${opt.value}")`);
            break;
          }

          // Check for partial match on value (supports country codes like "IN" for "India")
          if (valLower.length >= 2 && optValue.length >= 2) {
            if (optValue.includes(valLower) || valLower.includes(optValue)) {
              matchingOptionIndex = i;
              printLog(`Found value match at index ${i}: "${opt.text}"(value: "${opt.value}")`);
              break;
            }
          }

          // Check for partial match on id
          if (valLower.length >= 2 && optId.length >= 2) {
            if (optId.includes(valLower) || valLower.includes(optId)) {
              matchingOptionIndex = i;
              printLog(`Found id match at index ${i}: "${opt.text}"(id: "${opt.id}")`);
              break;
            }
          }

          // Check for partial match on label
          if (valLower.length >= 2 && optLabel.length >= 2) {
            if (optLabel.includes(valLower) || valLower.includes(optLabel)) {
              matchingOptionIndex = i;
              printLog(`Found label match at index ${i}: "${opt.text}"(label: "${opt.label}")`);
              break;
            }
          }
        }

        if (matchingOptionIndex >= 0) {
          // Use selectedIndex for more reliable selection
          select.selectedIndex = matchingOptionIndex;
          select.options[matchingOptionIndex].selected = true;

          // Fire multiple events to ensure frameworks detect the change
          select.dispatchEvent(new Event('change', { bubbles: true }));
          select.dispatchEvent(new Event('input', { bubbles: true }));
          if (isWorkdayDomain()) {
            this.simulateTabCommit(select);
          }
          printLog(`✓ Set select to option ${matchingOptionIndex}: ${select.options[matchingOptionIndex].text} `);
        } else {
          // Smart fallback: Check if this is a Yes/No question
          const optionsArr = Array.from(select.options);
          const hasYesOption = optionsArr.some((o: HTMLOptionElement) => o.text.toLowerCase().trim() === 'yes');
          const hasNoOption = optionsArr.some((o: HTMLOptionElement) => o.text.toLowerCase().trim() === 'no');
          const isYesNoQuestion = hasYesOption && hasNoOption;

          // Get the question text to determine appropriate default
          const questionText = this.extractQuestion(element).toLowerCase();

          if (isYesNoQuestion) {
            // For positive questions (willing, comfortable, agree, etc), default to Yes
            const positiveKeywords = ['willing', 'comfortable', 'agree', 'able', 'can you', 'do you', 'have you', 'are you'];
            const negativeKeywords = ['disability', 'conflict', 'legal issue', 'criminal', 'terminated', 'fired', 'sponsor', 'require visa', 'require sponsorship', 'visa sponsorship'];

            const isPositiveQuestion = positiveKeywords.some(kw => questionText.includes(kw));
            const isNegativeQuestion = negativeKeywords.some(kw => questionText.includes(kw));

            let defaultAnswer = 'yes'; // Default to Yes for most questions
            if (isNegativeQuestion) {
              defaultAnswer = 'no';
            }

            const targetIndex = optionsArr.findIndex((o: HTMLOptionElement) => o.text.toLowerCase().trim() === defaultAnswer);
            if (targetIndex >= 0) {
              select.selectedIndex = targetIndex;
              select.options[targetIndex].selected = true;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              select.dispatchEvent(new Event('input', { bubbles: true }));
              if (isWorkdayDomain()) {
                this.simulateTabCommit(select);
              }
              printLog(`⚠ N/A returned but Yes/No detected. Auto-selected: ${defaultAnswer.toUpperCase()} (question: ${isPositiveQuestion ? 'positive' : isNegativeQuestion ? 'negative' : 'neutral'})`);
            }
          } else if (this.isSensitiveField(questionText)) {
            // Never blind-guess race/veteran/disability/gender/etc — selecting
            // "the first option" here means fabricating a protected-status
            // answer with zero signal behind it. Leave unselected instead.
            printLog(`⚠ Sensitive field "${questionText}" — no confident match, leaving unselected`);
          } else {
            // For non-Yes/No questions, try to select first non-placeholder option
            let fallbackIndex = -1;
            for (let i = 0; i < optionsArr.length; i++) {
              const opt = optionsArr[i];
              const optText = opt.text.toLowerCase().trim();
              // Skip placeholder options
              if (optText && !optText.includes('select') && !optText.includes('choose') && !optText.includes('--')) {
                fallbackIndex = i;
                break;
              }
            }
            if (fallbackIndex >= 0) {
              select.selectedIndex = fallbackIndex;
              select.options[fallbackIndex].selected = true;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              select.dispatchEvent(new Event('input', { bubbles: true }));
              if (isWorkdayDomain()) {
                this.simulateTabCommit(select);
              }
              printLog(`⚠ No match for "${value}", auto-selected first valid option: ${select.options[fallbackIndex].text}`);
            } else {
              printLog(`⚠ No matching option found for value: ${value} `);
            }
          }
        }
        break;

      case 'select-multiple':
        const multiSelect = input as HTMLSelectElement;
        const values = value.split(',').map(v => v.trim().toLowerCase()).filter(v => v.length > 0);
        printLog(`Multi - select: looking for values: ${JSON.stringify(values)} `);

        let selectedCount = 0;
        Array.from(multiSelect.options).forEach((option, idx) => {
          const optText = option.text.toLowerCase().trim();
          const optVal = option.value.toLowerCase().trim();

          // Skip empty/placeholder options
          if (!optVal && (!optText || optText.includes('select') || optText.includes('choose'))) {
            return;
          }

          const shouldSelect = values.some(val => {
            // Exact match
            if (optText === val || optVal === val) return true;

            // Whole-word text match (see H1 — plain substring containment
            // matches "male" inside "female"). Value stays plain-substring
            // for short-code support.
            if (textualMatch(val, optText)) return true;
            if (val.length > 2 && optVal.length > 2) {
              if (optVal.includes(val) || val.includes(optVal)) return true;
            }

            return false;
          });

          if (shouldSelect) {
            option.selected = true;
            selectedCount++;
            printLog(`✓ Selected multi - select option ${idx}: "${option.text}"`);
          }
        });

        multiSelect.dispatchEvent(new Event('change', { bubbles: true }));
        multiSelect.dispatchEvent(new Event('input', { bubbles: true }));
        printLog(`Multi - select: selected ${selectedCount} options`);
        break;

      case 'image':
        // Image inputs are typically submit buttons
        break;

      case 'listbox':
      case 'combobox':
        printLog(`Interacting with ${type}: ${value} `);
        // 1. Click to open dropdown (handle both button and input)
        input.click();
        input.dispatchEvent(new Event('focus', { bubbles: true }));
        input.dispatchEvent(new Event('mousedown', { bubbles: true }));

        // Wait for options (adaptive) instead of a fixed 500ms sleep
        const optionSel = '[role="option"], [class*="option"]:not([class*="container"]), li[role="presentation"], .active-result, .wd-list-item';
        await waitForSelector(document, optionSel, 800);

        // 2. Find options - SCOPED SEARCH
        // First, try to find options container via aria-controls (Greenhouse/React-Select)
        let optionsContainer: Element | null = null;
        const ariaControls = input.getAttribute('aria-controls');
        if (ariaControls) {
          optionsContainer = document.getElementById(ariaControls);
          printLog(`Looking for options in container: #${ariaControls}`);
        }

        // Also check for parent dropdown container
        if (!optionsContainer) {
          optionsContainer = input.closest('.select__container, .select, [class*="dropdown"]');
        }

        const optionSelectors = [
          '[role="option"]',
          '[class*="option"]:not([class*="container"])',
          'li[role="presentation"]',
          '.active-result',
          '.wd-list-item'
        ];

        // Search in scoped container first, fallback to document if no container found
        let possibleOptions: NodeListOf<Element>;
        if (optionsContainer) {
          possibleOptions = optionsContainer.querySelectorAll(optionSelectors.join(', '));
          printLog(`Found ${possibleOptions.length} options in scoped container`);

          // If no options in scoped container, React-Select might use a portal
          // Look for recently opened menu portal
          if (possibleOptions.length === 0) {
            const menuPortal = document.querySelector('[class*="menu"][class*="css"]');
            if (menuPortal) {
              possibleOptions = menuPortal.querySelectorAll(optionSelectors.join(', '));
              printLog(`Found ${possibleOptions.length} options in React-Select menu portal`);
            }
          }
        } else {
          possibleOptions = document.querySelectorAll(optionSelectors.join(', '));
          printLog(`Found ${possibleOptions.length} possible options in DOM (global search)`);
        }

        let bestMatch: HTMLElement | null = null;
        let matchIndex = -1;
        const targetVal = value.toLowerCase().trim();

        // Filter and find match
        for (let i = 0; i < possibleOptions.length; i++) {
          const opt = possibleOptions[i] as HTMLElement;
          // Skip invisible options
          if (opt.hidden || opt.style.display === 'none' || opt.style.visibility === 'hidden') continue;

          const optText = (opt.textContent || '').toLowerCase().trim();

          // Exact match
          if (optText === targetVal) {
            bestMatch = opt;
            matchIndex = i;
            printLog(`Found exact ${type} option match: "${opt.textContent}"`);
            break;
          }

          // Partial match - use word boundary to avoid "Female" matching "Male"
          if (targetVal.length > 2) {
            const wordBoundaryRegex = new RegExp(`\\b${targetVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (wordBoundaryRegex.test(optText)) {
              bestMatch = opt;
              matchIndex = i;
              printLog(`Found partial ${type} option match: "${opt.textContent}"`);
              break;
            }
          }
        }

        if (bestMatch) {
          // Simple click
          bestMatch.click();
          await sleep(100);
          if (isWorkdayDomain()) {
            this.simulateTabCommit(input as HTMLElement);
          }
          printLog(`✓ Clicked ${type} option: ${bestMatch.textContent} `);
        } else {
          // Fallback: If no option matches, scrape visible options and ASK LLM AGAIN
          // This is critical for listboxes where options are dynamic/unknown initially
          if (possibleOptions.length > 0) {
            printLog(`⚠ Initial match failed.Re - asking LLM with ${possibleOptions.length} visible options...`);

            // Extract text from visible options
            const visibleOptions: string[] = [];
            const visibleOptionElements: HTMLElement[] = [];

            possibleOptions.forEach((element) => {
              const opt = element as HTMLElement;
              if (!opt.hidden && opt.style.display !== 'none' && opt.style.visibility !== 'hidden') {
                const text = opt.textContent?.trim();
                if (text) {
                  visibleOptions.push(text);
                  visibleOptionElements.push(opt);
                }
              }
            });

            if (visibleOptions.length > 0) {
              // Get new answer from LLM with specific options
              const question = this.extractQuestion(input); // Re-extract question
              const userInfo = personals.user_information_all || JSON.stringify(personals);
              const newAnswer = await llmManager.getAnswer(
                question,
                visibleOptions,
                'single_select', // Treat as single select now that we have options
                undefined,
                userInfo,
                JSON.stringify(personals)
              );

              printLog(`LLM provided new answer based on visible options: "${newAnswer}"`);

              if (newAnswer) {
                // VALIDATION: Check if the new answer makes sense for the field type
                const question = this.extractQuestion(input);
                const questionLower = question.toLowerCase();
                const newAnswerClean = newAnswer.trim();

                // Detect if options don't match field type (e.g., years in Country field)
                const isYearField = questionLower.includes('year') || questionLower.includes('start year') || questionLower.includes('end year');
                const isCountryField = questionLower.includes('country') || questionLower.includes('state') || questionLower.includes('province');
                const isAreaField = questionLower.includes('area of study') || questionLower.includes('field') || questionLower.includes('functional area');

                // Check if newAnswer looks like a year (4 digits)
                const looksLikeYear = /^\d{4}$/.test(newAnswerClean);

                // SKIP if there's a type mismatch
                if ((isCountryField || isAreaField) && looksLikeYear) {
                  printLog(`⚠ SKIPPING mismatched option: "${newAnswerClean}" looks like a year but field is "${question}"`);
                  // Don't click anything, fall through to typing
                } else if (isYearField && !looksLikeYear && visibleOptions.length > 50) {
                  // If it's a year field but answer doesn't look like a year, and there are many options (likely years), be cautious
                  printLog(`⚠ Year field "${question}" but answer "${newAnswerClean}" doesn't look like a year. Skipping.`);
                } else {
                  // Validation passed, proceed with matching
                  const newTargetVal = newAnswer.toLowerCase().trim();
                  let newBestMatch: HTMLElement | null = null;

                  for (let i = 0; i < visibleOptionElements.length; i++) {
                    const opt = visibleOptionElements[i];
                    const optText = (opt.textContent || '').toLowerCase().trim();

                    // Exact match is always valid
                    if (optText === newTargetVal) {
                      newBestMatch = opt;
                      break;
                    }

                    // For partial matches, require word boundary to avoid "Female" matching "Male"
                    // Use word boundary regex: the target value must appear as a whole word
                    if (newTargetVal.length > 2) {
                      const wordBoundaryRegex = new RegExp(`\\b${newTargetVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                      if (wordBoundaryRegex.test(optText)) {
                        newBestMatch = opt;
                        break;
                      }
                    }
                  }

                  if (newBestMatch) {
                    // Simple click
                    newBestMatch.click();
                    await sleep(100);
                    if (isWorkdayDomain()) {
                      this.simulateTabCommit(input as HTMLElement);
                    }
                    printLog(`✓ Clicked ${type} option(after re - ask): ${newBestMatch.textContent} `);
                    return; // Success!
                  }
                }
              }
            }
          }

          // If fallback failed, try typing (only for combobox inputs)
          if (type === 'combobox' && input instanceof HTMLInputElement) {
            printLog(`⚠ No combobox option found for "${value}".Trying to type it...`);
            if (isWorkdayDomain()) {
              this.setReactInputValue(input, value);
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
              this.simulateTabCommit(input);
            } else {
              input.value = value;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
            }
          } else {
            printLog(`⚠ No option found for ${type} "${value}" even after re - asking.`);
          }
        }
        break;


      case 'ui5-date':
        // Handle UI5 Date Picker
        // Convert to MM/DD/YYYY if possible (standard US format often required by these widgets)
        // Try to respect format-pattern if present
        let dateValue = value;
        const formatPattern = element.getAttribute('format-pattern') || 'MM/dd/yyyy'; // Default to US format usually

        // If value is YYYY-MM (from our persona), and format is MM/dd/yyyy
        if (value.match(/^\d{4}-\d{2}$/)) {
          const parts = value.split('-');
          // Default to 1st of the month
          dateValue = `${parts[1]}/01/${parts[0]}`;
        } else if (value.match(/^\d{4}-\d{2}-\d{2}$/)) { // YYYY-MM-DD
          const parts = value.split('-');
          dateValue = `${parts[1]}/${parts[2]}/${parts[0]}`;
        }

        printLog(`Setting UI5 Date Picker value to: ${dateValue}`);

        // Try setting value property
        if ('value' in element) {
          (element as any).value = dateValue;
        } else {
          element.setAttribute('value', dateValue);
        }

        // Dispatch events to trigger internal logic
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        break;

      default:
        // For textarea and other elements
        if (input.tagName.toLowerCase() === 'textarea') {
          if (isWorkdayDomain()) {
            this.commitWorkdayFieldValue(input as HTMLTextAreaElement, value);
          } else {
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        } else if (input.tagName.toLowerCase().startsWith('spl-')) {
          // Handle spl-* Custom Elements
          printLog(`Setting value for custom element ${input.tagName}`);

          // Helper to set value on internal input if accessible via Shadow DOM
          const setShadowValue = (host: HTMLElement, val: string) => {
            if (host.shadowRoot) {
              const internalInput = host.shadowRoot.querySelector('input, textarea');
              if (internalInput) {
                (internalInput as any).value = val;
                internalInput.dispatchEvent(new Event('input', { bubbles: true }));
                internalInput.dispatchEvent(new Event('change', { bubbles: true }));
                printLog(`Set value on internal shadow input for ${host.tagName}`);
                return true;
              }
            }
            return false;
          };

          if (input.tagName.toLowerCase() === 'spl-phone-field') {
            // For phone field, it might pass complex object. 
            // But usually typing works? Text value is safest safe-bet.
            // Try setting attribute and property.
            (input as any).value = value;
            input.setAttribute('value', value);

            // Try shadow
            setShadowValue(input, value);
          } else {
            // spl-input, spl-textarea
            // 1. Try Shadow DOM first (most reliable for interactions)
            const shadowSet = setShadowValue(input, value);

            // 2. Always set on host as well (for binding)
            (input as any).value = value;
            input.setAttribute('value', value);
          }

          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
        }
        break;
    }
  }

  // Helper to parse various date formats to ISO (yyyy-mm-dd)
  private parseDateToISO(value: string): string | null {
    const trimmed = value.trim();

    // Prevent pure numbers (e.g., "2022" or "3") from being parsed as full dates
    // Native Date("2022") evaluates to Jan 1, 2022, which incorrectly overwrites the month
    if (/^\d+$/.test(trimmed)) {
      return null;
    }

    // Try common formats
    const datePatterns = [
      // yyyy-mm-dd (already ISO)
      { regex: /^(\d{4})-(\d{1,2})-(\d{1,2})$/, format: (m: RegExpMatchArray) => `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` },
      // mm/yyyy or mm-yyyy (Workday month/year) → first day of month
      { regex: /^(\d{1,2})[\/\-](\d{4})$/, format: (m: RegExpMatchArray) => `${m[2]}-${m[1].padStart(2, '0')}-01` },
      // yyyy/mm or yyyy-mm
      { regex: /^(\d{4})[\/\-](\d{1,2})$/, format: (m: RegExpMatchArray) => `${m[1]}-${m[2].padStart(2, '0')}-01` },
      // mm/dd/yyyy or mm-dd-yyyy (US)
      { regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/, format: (m: RegExpMatchArray) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` },
      // Month dd, yyyy
      {
        regex: /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2}),? (\d{4})$/i, format: (m: RegExpMatchArray) => {
          const months: { [key: string]: string } = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
          return `${m[3]}-${months[m[1].toLowerCase().substring(0, 3)]}-${m[2].padStart(2, '0')}`;
        }
      },
    ];

    for (const pattern of datePatterns) {
      const match = trimmed.match(pattern.regex);
      if (match) {
        const result = pattern.format(match);
        // Validate by parsing the ISO string as UTC to avoid timezone shifts
        const [y, mo, d] = result.split('-').map(Number);
        const testDate = new Date(Date.UTC(y, mo - 1, d));
        if (!isNaN(testDate.getTime()) && testDate.getUTCFullYear() === y &&
            testDate.getUTCMonth() === mo - 1 && testDate.getUTCDate() === d) {
          return result;
        }
      }
    }

    // Fallback: JavaScript's native Date parsing (timezone-safe via local getters)
    const nativeDate = new Date(trimmed);
    if (!isNaN(nativeDate.getTime())) {
      const y = nativeDate.getFullYear();
      const mo = String(nativeDate.getMonth() + 1).padStart(2, '0');
      const d = String(nativeDate.getDate()).padStart(2, '0');
      return `${y}-${mo}-${d}`;
    }

    return null;
  }

  private async getSettings(): Promise<any> {
    return new Promise((resolve) => {
      chrome.storage.sync.get(['settings'], (result) => {
        resolve(result.settings || {});
      });
    });
  }

  getStatus(): { isRunning: boolean; filledCount: number } {
    return { isRunning: this.isRunning, filledCount: this.filledCount };
  }

  hasFormElements(): boolean {
    const formElementSelector = 'input, textarea, select, button[aria-haspopup="listbox"], ui5-date-picker-xweb-calendar-widget, spl-input, spl-textarea, spl-select, spl-autocomplete, spl-phone-field, spl-checkbox, spl-radio-group';
    if (document.querySelector(formElementSelector)) {
      return true;
    }

    // Match findFormElements(): recursively walk nested shadow trees
    const hasInShadow = (container: Element | ShadowRoot): boolean => {
      if (container.querySelector(formElementSelector)) return true;
      const all = container.querySelectorAll('*');
      for (let i = 0; i < all.length; i++) {
        const el = all[i];
        if (!el.tagName.includes('-') || !el.shadowRoot) continue;
        if (hasInShadow(el.shadowRoot)) return true;
      }
      return false;
    };

    const shadowHosts = document.querySelectorAll('sr-screening-questions-form, oc-screening-questions-form');
    for (const host of Array.from(shadowHosts)) {
      if (host.shadowRoot && hasInShadow(host.shadowRoot)) {
        return true;
      }
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Safe under dynamic re-injection: refresh globals from this bundle so
// extension reloads/updates replace stale handlers — UNLESS a fill is
// currently running under the previous instance. Unconditionally replacing a
// running instance hands it a fresh isRunning=false sibling, defeating its
// own re-entrancy guard and letting two fill loops race the same live DOM
// (double LLM calls, interleaved writes) — see H7.
const __w = window as any;
const existingFiller = __w.__formAutopilotFormFiller as FormFiller | undefined;
const formFiller = (existingFiller && existingFiller.getStatus().isRunning) ? existingFiller : new FormFiller();
__w.__formAutopilotFormFiller = formFiller;
__w.startFormFilling = () => {
  void (__w.__formAutopilotFormFiller as FormFiller).startFilling();
};
__w.startFormFillingAsync = () => (__w.__formAutopilotFormFiller as FormFiller).startFilling();
__w.getFormFillerStatus = () => (__w.__formAutopilotFormFiller as FormFiller).getStatus();

if (!__w.__formAutopilotListenerBound) {
  __w.__formAutopilotListenerBound = true;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const filler = __w.__formAutopilotFormFiller as FormFiller | undefined;
    if (!filler) return false;

    // Background probes for an existing listener before re-injecting
    if (message.action === 'ping') {
      sendResponse({ pong: true });
      return false;
    }

    // Any frame without forms stays silent so aggregated frame replies aren't polluted
    if (message.action === 'startFilling' && !filler.hasFormElements()) {
      sendResponse({ success: true, filledCount: 0, skipped: true });
      return false;
    }

    if (message.action === 'startFilling') {
      filler.startFilling().then((filled) => {
        sendResponse({ success: true, filledCount: filled });
      }).catch((error) => {
        sendResponse({ success: false, error: String(error) });
      });
      return true;
    }

    if (message.action === 'getStatus') {
      sendResponse(filler.getStatus());
      return true;
    }
  });
}

if (window.self === window.top) {
  printLog('Form filler content script loaded');
}

