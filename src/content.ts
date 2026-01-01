// Content script for form filling
import { llmManager } from './modules/ai/llm_manager.js';
import { loadSecrets } from './config/secrets.js';
import { personals } from './config/personals.js';
import { printLog } from './modules/helpers.js';

interface FormElement {
  element: HTMLElement;
  type: string;
  tagName: string;
  question?: string;
  options?: string[];
}

// === HELPER FUNCTIONS ===

/**
 * Detect if current page is Workday (needs delays for bot detection evasion)
 */
function isWorkdayDomain(): boolean {
  const hostname = window.location.hostname.toLowerCase();
  return hostname.includes('workday.com') || hostname.includes('myworkday.com');
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

class FormFiller {
  private isRunning: boolean = false;
  private filledCount: number = 0;

  async startFilling(): Promise<void> {
    if (this.isRunning) {
      printLog("Form filling already in progress...");
      return;
    }

    this.isRunning = true;
    this.filledCount = 0;
    printLog("Starting form filling...");

    try {
      // Initialize LLM manager
      const secrets = await loadSecrets();
      await llmManager.initializeClients(secrets);

      // Find all form elements
      const formElements = this.findFormElements();
      printLog(`Found ${formElements.length} form elements to fill`);

      if (formElements.length === 0) {
        printLog("No form elements found to fill");
        return;
      }

      // Check if batch mode is enabled (default: true)
      const settings = await this.getSettings();
      const batchModeEnabled = settings.batch_mode !== false;
      const chunkModeEnabled = settings.chunk_mode !== false; // Default true if not set

      if (batchModeEnabled) {
        // BATCH MODE: Process in chunks (if enabled) to avoid overloading LLM or Browser
        printLog(chunkModeEnabled ? "Using BATCH mode (faster, chunked)" : "Using BATCH mode (fastest, all-at-once)");
        const userInfo = personals.user_information_all || JSON.stringify(personals);

        // Process questions in chunks of 25 (if chunking is on) or all at once
        const CHUNK_SIZE = chunkModeEnabled ? 25 : formElements.length;
        for (let i = 0; i < formElements.length; i += CHUNK_SIZE) {
          const chunk = formElements.slice(i, i + CHUNK_SIZE);
          printLog(`Processing batch chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} elements)...`);

          // 1. Prepare questions for this chunk
          const questionsList = chunk.map(el => ({
            question: this.getEnhancedQuestion(el),
            options: el.options,
            questionType: this.determineQuestionType(el.type, el.options)
          }));

          // 2. Get answers for this chunk from LLM
          printLog(`Sending batch request for ${questionsList.length} questions...`);
          const batchAnswers = await llmManager.getBatchAnswers(
            questionsList,
            undefined,
            userInfo,
            JSON.stringify(personals)
          );
          printLog(`Got ${batchAnswers.size} answers for chunk`);

          // 3. Fill elements in this chunk (SEQUENTIAL to prevent UI interference)
          // We must fill sequentially because opening a dropdown often closes others
          // Use pre-computed enhanced questions from questionsList to ensure consistency
          for (let j = 0; j < chunk.length; j++) {
            const formElement = chunk[j];
            const enhancedQuestion = questionsList[j].question; // Use same question from batch request
            try {
              const cachedAnswer = batchAnswers.get(enhancedQuestion);
              if (!cachedAnswer) {
                printLog(`⚠️ No cached answer for: ${enhancedQuestion.substring(0, 60)}...`);
              }
              await this.fillElementWithAnswer(formElement, cachedAnswer);

              // Small delay between elements to allow UI to settle
              await this.delay(100);
            } catch (error) {
              printLog(`Error filling element: ${error}`);
            }
          }

          // Small delay between chunks to let browser render/process events
          if (i + CHUNK_SIZE < formElements.length) {
            await this.delay(500);
          }
        }
      } else {
        // SEQUENTIAL MODE: One LLM call per field (more accurate)
        const delayMessage = isWorkdayDomain()
          ? " with delays for Workday detection evasion"
          : "";
        printLog(`Using SEQUENTIAL mode (more accurate)${delayMessage}`);

        for (const formElement of formElements) {
          await this.fillElement(formElement);
          // Conditional delay: 500-1500ms on Workday, 0ms elsewhere
          const delay = getConditionalDelay(500, 1500);
          if (delay > 0) {
            await sleep(delay);
          }
        }
      }

      printLog(`Form filling complete! Filled ${this.filledCount} elements.`);
    } catch (error) {
      printLog(`Error during form filling: ${error}`);
    } finally {
      this.isRunning = false;
    }
  }

  private findFormElements(): FormElement[] {
    const elements: FormElement[] = [];

    // Define the selector for form elements
    const formElementSelector = 'input, textarea, select, button[aria-haspopup="listbox"], ui5-date-picker-xweb-calendar-widget, spl-input, spl-textarea, spl-select, spl-autocomplete, spl-phone-field, spl-checkbox, spl-radio';

    // 1. Find elements in Light DOM
    const lightDomInputs = Array.from(document.querySelectorAll(formElementSelector));

    // 2. Find elements in Shadow DOM of specific containers (e.g., SmartRecruiters screening form)
    const shadowInputs: Element[] = [];
    const shadowHosts = document.querySelectorAll('sr-screening-questions-form, oc-screening-questions-form');

    shadowHosts.forEach(host => {
      if (host.shadowRoot) {
        const found = host.shadowRoot.querySelectorAll(formElementSelector);
        shadowInputs.push(...Array.from(found));
        printLog(`Found ${found.length} elements in Shadow DOM of ${host.tagName}`);
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
          inputType === 'image') {
          return;
        }
      }

      // Skip Workday utility buttons (Language, Settings, Account menus)
      if (input.getAttribute('data-automation-id') === 'utilityMenuButton' ||
        input.closest('[data-automation-id="utilityButtonBar"]')) {
        return;
      }

      // Skip disabled or readonly inputs
      if ((input as any).disabled || (input as any).readOnly || input.getAttribute('readonly') !== null) {
        return;
      }

      // Skip hidden elements (CSS hidden or HTML hidden attribute)
      // BUT: Skip these checks for spl-* elements (custom components may have non-standard styling)
      if (!isSplElement) {
        if (input.hidden ||
          input.getAttribute('hidden') !== null ||
          (input.getAttribute('aria-hidden') === 'true' && !isListbox && input.tagName.toLowerCase() !== 'ui5-date-picker-xweb-calendar-widget') ||
          getComputedStyle(input).display === 'none' ||
          getComputedStyle(input).visibility === 'hidden') {
          return;
        }
      } else {
        // For spl-* elements, log that we found one
        printLog(`[SPL] Found ${tagName}: id=${input.id || 'none'}, label=${input.getAttribute('label') || 'none'}`);
      }

      // FORCE FILL MODE: Don't skip based on existing values
      // Only skip if already checked checkboxes/radios AND they match what we would set
      // (We'll let the LLM decide what to set)

      // For select elements, always include them (force fill)
      if (input.tagName.toLowerCase() === 'select') {
        const selectLabel = this.extractQuestion(input);
        printLog(`Select "${selectLabel}": included for filling (force fill mode)`);
      }

      // For checkboxes/radios, include them (force fill will set based on LLM answer)
      // For text inputs, include them even if they have values (force fill)

      const question = this.extractQuestion(input);
      const options = this.extractOptions(input);

      // Check for combobox role or listbox popup
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
        } else if (tagName === 'spl-radio') {
          type = 'radio';
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
    const divBasedElements = this.findDivBasedFormElements();

    // Merge, avoiding duplicates (by element reference)
    const existingElements = new Set(elements.map(e => e.element));
    divBasedElements.forEach(divEl => {
      if (!existingElements.has(divEl.element)) {
        elements.push(divEl);
      }
    });

    printLog(`Total elements to fill: ${elements.length} (${elements.length - divBasedElements.length} standard + ${divBasedElements.filter(d => !existingElements.has(d.element)).length} div-based)`);

    return elements;
  }

  // Detect complex div-based form structures (DHTMLX, Material UI, Bootstrap, etc.)
  private findDivBasedFormElements(): FormElement[] {
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
      const wrappers = document.querySelectorAll(pattern.wrapper);

      wrappers.forEach(wrapper => {
        // Find label within wrapper
        const labelEl = wrapper.querySelector(pattern.label);
        const labelText = labelEl?.textContent?.trim() || '';

        // Find input control within wrapper
        const controlEl = wrapper.querySelector(pattern.control) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

        if (controlEl && labelText) {
          // Skip if already filled, hidden, disabled, etc.
          if (this.shouldSkipElement(controlEl)) {
            return;
          }

          const options = this.extractOptions(controlEl);

          elements.push({
            element: controlEl,
            type: controlEl.type || (controlEl.tagName.toLowerCase() === 'select' ? 'select-one' : 'text'),
            tagName: controlEl.tagName.toLowerCase(),
            question: labelText,
            options
          });

          printLog(`Div-based element found: "${labelText}" (type: ${controlEl.type || 'text'})`);
        }
      });
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
        el.type === 'reset' || el.type === 'image') {
        return true;
      }
    }

    // Skip disabled or readonly
    if ((input as any).disabled || (input as any).readOnly) {
      return true;
    }

    // Skip hidden via CSS
    if (input.hidden || getComputedStyle(input).display === 'none' || getComputedStyle(input).visibility === 'hidden') {
      return true;
    }

    // FORCE FILL MODE: Don't skip based on existing values
    // All visible, enabled elements will be filled with LLM responses

    return false;
  }

  private extractQuestion(element: HTMLElement): string {
    // Try to find associated label
    let question = '';

    // Check for "label" attribute (Common in Web Components like spl-input)
    if (element.hasAttribute('label')) {
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
    }

    if (question) return question;

    // Check for id and associated label
    if (element.id) {
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) {
        question = label.textContent?.trim() || '';
      }
    }

    // Check for parent label
    if (!question) {
      const parentLabel = element.closest('label');
      if (parentLabel) {
        question = parentLabel.textContent?.trim() || '';
      }
    }

    // Check for fieldset legend (common in listboxes/radio groups)
    if (!question) {
      const fieldset = element.closest('fieldset');
      if (fieldset) {
        const legend = fieldset.querySelector('legend');
        if (legend) {
          question = legend.textContent?.trim() || '';
        }
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
          question = prev.textContent?.trim() || '';
          // printLog(`Found label via previous sibling ${prev.tagName}: ${question}`);
        }
      }
    }

    // Check for nearby text using more aggressive upward traversal (fixing "Type your response" issue)
    // Common ATS patterns: Greenhouse (.application-question), Lever, etc.
    if (!question) {
      // 1. Check specific known patterns (Greenhouse, etc.)
      const greenhouseWrapper = element.closest('.application-question, .field, .form-group, .form-item, tr');
      if (greenhouseWrapper) {
        const potentialLabel = greenhouseWrapper.querySelector('.application-label, .label, .field-label, label, .text, th');
        if (potentialLabel) {
          // Ensure this label isn't for another input (basic check)
          question = potentialLabel.textContent?.trim() || '';
        }
      }

      // 2. Generic sibling check (if input is in a wrapper like div.application-field)
      if (!question) {
        const parent = element.parentElement;
        if (parent) {
          // Check previous sibling of parent (often the label container)
          const prevSibling = parent.previousElementSibling;
          if (prevSibling && (prevSibling.className.includes('label') || prevSibling.className.includes('text'))) {
            question = prevSibling.textContent?.trim() || '';
          }
        }
      }
    }

    // Check for name attribute
    if (!question) {
      question = element.getAttribute('name') || '';
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

    // --- SUCCESSFACTORS / GENERIC REPEATER HANDLING ---
    // Detects entry numbers in repeating sections (e.g. Work Experience, Education)
    // Supports multiple patterns:
    // - SuccessFactors: "Row number 1"
    // - Workday: "Work Experience 1", "Education 1", etc.
    // - Array-indexed IDs: experienceData[0].title, educationData[1].school
    let rowText = '';
    let entryType = ''; // To track what type of entry this is (experience, education, etc.)

    // Method 0: Check for array-indexed element IDs (e.g., experienceData[0].title)
    const elementId = element.id || '';
    const arrayIndexMatch = elementId.match(/(experience|education|employment|work|job|school)Data?\[(\d+)\]/i);
    if (arrayIndexMatch) {
      entryType = arrayIndexMatch[1]; // e.g., "experience", "education"
      const entryNum = parseInt(arrayIndexMatch[2]) + 1; // Convert 0-indexed to 1-indexed
      question += ` [${entryType.charAt(0).toUpperCase() + entryType.slice(1)} Entry: ${entryNum}]`;
      printLog(`Context added: ${entryType} Entry ${entryNum} from array-indexed ID`);
    }

    // Only do other detection if we didn't find an array index
    if (!arrayIndexMatch) {
      const rowHeader = element.closest('.rcmSectionComponent')?.previousElementSibling; // SuccessFactors pattern
      if (rowHeader && rowHeader.textContent?.includes('Row number')) {
        rowText = rowHeader.textContent.trim();
      } else {
        // Check for Workday patterns
        // Method 1: Use aria-labelledby (most reliable for Workday)
        let current = element.parentElement;
        for (let i = 0; i < 20 && current && !rowText; i++) {
          const labelId = current.getAttribute('aria-labelledby');
          if (labelId) {
            const labelElement = document.getElementById(labelId);
            if (labelElement) {
              const labelText = labelElement.textContent?.trim() || '';
              const workdayMatch = labelText.match(/(Work Experience|Education|Employment|Position|Job|School)\s+(\d+)/i);
              if (workdayMatch) {
                rowText = labelText;
                printLog(`Found Workday section via aria-labelledby: ${rowText}`);
                break;
              }
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
            const workdayMatch = textContent.match(/(Work Experience|Education|Employment|Position|Job|School)\s+(\d+)/i);
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
      // Normalize to "[Entry: X]" to be crystal clear for LLM
      // Support multiple patterns
      let match = rowText.match(/Row number\s*(\d+)/i);
      if (match) {
        const entryNum = match[1];
        question += ` [Entry: ${entryNum}]`;
        printLog(`Context added: Entry ${entryNum} for field (Row number)`);
      } else {
        // Try Workday patterns
        match = rowText.match(/(Work Experience|Education|Employment|Position|Job|School)\s+(\d+)/i);
        if (match) {
          const entryNum = match[2];
          question += ` [Entry: ${entryNum}]`;
          printLog(`Context added: Entry ${entryNum} for field (${match[1]})`);
        } else {
          // Fallback: just append the row text
          question += ` [${rowText}]`;
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

    return question || 'Form field';
  }

  private extractOptions(element: HTMLElement): string[] {
    const options: string[] = [];

    if (element.tagName.toLowerCase() === 'select') {
      const select = element as HTMLSelectElement;
      Array.from(select.options).forEach(option => {
        if (option.value && option.value !== '') {
          options.push(option.text || option.value);
        }
      });
    } else if (element.getAttribute('type') === 'radio' || element.getAttribute('type') === 'checkbox') {
      const name = element.getAttribute('name');
      if (name) {
        const radioButtons = document.querySelectorAll<HTMLInputElement>(`input[type="${element.getAttribute('type')}"][name="${name}"]`);
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
      const label = document.querySelector(`label[for="${element.id}"]`);
      if (label) {
        return label.textContent?.trim() || null;
      }
    }

    const parent = element.parentElement;
    if (parent && parent.tagName.toLowerCase() === 'label') {
      return parent.textContent?.trim() || null;
    }

    return null;
  }

  private async fillElement(formElement: FormElement): Promise<void> {
    try {
      const { element, type, question, options } = formElement;

      printLog(`Filling element: ${question || 'Unknown field'
        }`);

      const enhancedQuestion = this.getEnhancedQuestion(formElement);

      // Get answer from LLM
      const userInfo = personals.user_information_all || JSON.stringify(personals);
      const answer = await llmManager.getAnswer(
        enhancedQuestion,
        options,
        this.determineQuestionType(type, options),
        undefined,
        userInfo,
        JSON.stringify(personals)
      );

      if (!answer) {
        printLog(`No answer generated for: ${question} `);
        return;
      }

      // Fill the element based on type
      await this.setElementValue(element, type, answer, options);
      this.filledCount++;

      printLog(`✓ Filled: ${question} with: ${answer} `);
    } catch (error) {
      printLog(`Error filling element: ${error} `);
    }
  }

  // Optimized version that uses pre-cached answer
  private async fillElementWithAnswer(formElement: FormElement, cachedAnswer?: string): Promise<void> {
    try {
      const { element, type, question, options } = formElement;

      let answer = cachedAnswer;

      // Fall back to individual LLM call if no cached answer
      if (!answer) {
        const enhancedQuestion = this.getEnhancedQuestion(formElement);
        const userInfo = personals.user_information_all || JSON.stringify(personals);
        const llmAnswer = await llmManager.getAnswer(
          enhancedQuestion,
          options,
          this.determineQuestionType(type, options),
          undefined,
          userInfo,
          JSON.stringify(personals)
        );
        answer = llmAnswer || undefined;
      }

      if (!answer) {
        printLog(`No answer for: ${question} `);
        return;
      }

      // Fill the element based on type
      await this.setElementValue(element, type, answer, options);
      this.filledCount++;

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

      // Workday-specific: Start/End dates often use MM/YYYY format
      const isWorkdayMonthYearField =
        (questionLower.includes('start') || questionLower.includes('end') ||
          questionLower.includes('from') || questionLower.includes('to')) &&
        (questionLower.includes('date') || questionLower.includes('month') ||
          placeholder.toUpperCase().includes('MM') && !placeholder.toUpperCase().includes('DD'));

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
        placeholder.toLowerCase().includes('date')
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

  private async setElementValue(
    element: HTMLElement,
    type: string,
    value: string,
    options?: string[]
  ): Promise<void> {
    const input = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

    switch (type) {
      case 'text':
      case 'email':
      case 'url':
      case 'search':
      case 'tel':
      case 'password':
        // SPECIAL HANDLING: Workday date spinbuttons (Month/Year)
        const spinRole = input.getAttribute('role');
        const ariaLabel = input.getAttribute('aria-label') || '';

        if (spinRole === 'spinbutton' && (ariaLabel === 'Month' || ariaLabel === 'Year')) {
          // This is a Workday date spinbutton - parse MM/YYYY format
          const dateMatch = value.match(/(\d{1,2})\/(\d{4})/);
          if (dateMatch) {
            const month = parseInt(dateMatch[1]);
            const year = parseInt(dateMatch[2]);

            // Find the parent dateInputWrapper to locate both Month and Year inputs
            const dateWrapper = input.closest('[data-automation-id="dateInputWrapper"]');
            if (dateWrapper) {
              const monthInput = dateWrapper.querySelector('[data-automation-id="dateSectionMonth-input"]') as HTMLInputElement;
              const yearInput = dateWrapper.querySelector('[data-automation-id="dateSectionYear-input"]') as HTMLInputElement;

              if (monthInput && yearInput) {
                // Set both values
                monthInput.value = String(month);
                monthInput.setAttribute('aria-valuenow', String(month));
                monthInput.setAttribute('aria-valuetext', String(month));
                monthInput.dispatchEvent(new Event('input', { bubbles: true }));
                monthInput.dispatchEvent(new Event('change', { bubbles: true }));
                monthInput.dispatchEvent(new Event('blur', { bubbles: true }));

                yearInput.value = String(year);
                yearInput.setAttribute('aria-valuenow', String(year));
                yearInput.setAttribute('aria-valuetext', String(year));
                yearInput.dispatchEvent(new Event('input', { bubbles: true }));
                yearInput.dispatchEvent(new Event('change', { bubbles: true }));
                yearInput.dispatchEvent(new Event('blur', { bubbles: true }));

                printLog(`✓ Set Workday date spinbuttons: Month=${month}, Year=${year}`);
                break; // Exit the switch
              }
            }

            // Fallback: Set just this spinbutton with the appropriate part
            if (ariaLabel === 'Month') {
              input.value = String(month);
              input.setAttribute('aria-valuenow', String(month));
              printLog(`✓ Set Month spinbutton: ${month}`);
            } else if (ariaLabel === 'Year') {
              input.value = String(year);
              input.setAttribute('aria-valuenow', String(year));
              printLog(`✓ Set Year spinbutton: ${year}`);
            }
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }

        // Regular text input handling
        // Check for maxlength
        const maxLen = input.getAttribute('maxlength');
        let textValue = value;
        if (maxLen && parseInt(maxLen) > 0) {
          textValue = value.substring(0, parseInt(maxLen));
        }
        input.value = textValue;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
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

          input.value = String(numVal);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
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
            formattedDate = `${month}${separator}${day}${separator}${year} `;
          } else if (expectedFormat.startsWith('DD') && expectedFormat.includes('MM')) {
            // DD-MM-YYYY or DD/MM/YYYY
            const separator = expectedFormat.includes('/') ? '/' : '-';
            formattedDate = `${day}${separator}${month}${separator}${year} `;
          } else if (expectedFormat.startsWith('YYYY')) {
            // YYYY-MM-DD or YYYY/MM/DD
            const separator = expectedFormat.includes('/') ? '/' : '-';
            formattedDate = `${year}${separator}${month}${separator}${day} `;
          }

          // For HTML5 date inputs, always use YYYY-MM-DD regardless of placeholder
          if (input.type === 'date') {
            input.value = parsedDate;
          } else {
            input.value = formattedDate;
          }

          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          printLog(`✓ Set date to: ${input.value} (format: ${expectedFormat})`);
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
          input.value = `${hours}:${mins}:${secs} `;
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

        // Auto-check if this is a terms/conditions/agreement checkbox
        const isTermsCheckbox =
          checkboxLabel.includes('agree') ||
          checkboxLabel.includes('accept') ||
          checkboxLabel.includes('terms') ||
          checkboxLabel.includes('conditions') ||
          checkboxLabel.includes('privacy') ||
          checkboxLabel.includes('policy') ||
          checkboxLabel.includes('read and') ||
          checkboxLabel.includes('i have read') ||
          checkboxLabel.includes('consent') ||
          checkboxLabel.includes('subscribe') ||
          checkboxLabel.includes('newsletter') ||
          checkboxLabel.includes('confirm') ||
          checkboxLabel.includes('acknowledge');

        // For checkboxes, check if value matches positive responses OR if it's a terms checkbox
        const checkValue = value.toLowerCase().trim();
        const shouldCheck = isTermsCheckbox ||
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
        }
        break;

      case 'radio':
        // SPECIAL HANDLING: spl-radio (SmartRecruiters custom web component)
        if (element.tagName.toLowerCase() === 'spl-radio') {
          const optionText = (element.querySelector('[slot="label"], [slot="label-content"]')?.textContent || element.textContent || '').trim();
          const optionValue = element.getAttribute('value') || '';

          printLog(`Checking spl-radio: option="${optionText}", value="${optionValue}" vs target="${value}"`);

          const isMatch =
            (optionText && value.toLowerCase().includes(optionText.toLowerCase())) ||
            (optionText && optionText.toLowerCase().includes(value.toLowerCase())) ||
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
          const radios = document.querySelectorAll<HTMLInputElement>(`input[type = "radio"][name = "${name}"]`);
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

            // Check for partial match (only if strings are long enough)
            if (valLowerRadio.length > 2 && labelLower.length > 2) {
              if (labelLower.includes(valLowerRadio) || valLowerRadio.includes(labelLower)) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
                radio.dispatchEvent(new Event('click', { bubbles: true }));
                radio.dispatchEvent(new Event('input', { bubbles: true }));
                printLog(`✓ Selected radio option ${idx} (partial): "${radioLabel}"`);
                foundRadio = true;
                return;
              }
            }

            // Check value partial match
            if (valLowerRadio.length > 2 && radioValueLower.length > 2) {
              if (radioValueLower.includes(valLowerRadio) || valLowerRadio.includes(radioValueLower)) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change', { bubbles: true }));
                radio.dispatchEvent(new Event('click', { bubbles: true }));
                radio.dispatchEvent(new Event('input', { bubbles: true }));
                printLog(`✓ Selected radio option ${idx} (value match): "${radioLabel}"`);
                foundRadio = true;
              }
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

          // Skip placeholder options
          const isPlaceholderOpt = optValue === '' || optValue === 'none' || optValue === 'null' ||
            optValue === 'select' || optValue === '-1' || optValue === '0' ||
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

          // Check for partial match on text
          if (valLower.length >= 2 && optText.length >= 2) {
            if (optText.includes(valLower) || valLower.includes(optText)) {
              matchingOptionIndex = i;
              printLog(`Found text match at index ${i}: "${opt.text}"(value: "${opt.value}")`);
              break;
            }
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
          printLog(`✓ Set select to option ${matchingOptionIndex}: ${select.options[matchingOptionIndex].text} `);
        } else {
          printLog(`⚠ No matching option found for value: ${value} `);
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

            // Partial match only for longer strings
            if (val.length > 2 && optText.length > 2) {
              if (optText.includes(val) || val.includes(optText)) return true;
            }
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

      case 'file':
        // File inputs cannot be programmatically set for security reasons
        printLog('File input cannot be filled programmatically');
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

        // Wait for options to appear
        await this.delay(500);

        // 2. Find options. 
        // For Workday (listbox), options often have role="option" or are in a container with role="listbox"
        // For React Select (combobox), options are in a portal
        const optionSelectors = [
          '[role="option"]',
          '[class*="option"]',
          'li[role="presentation"]', // Some frameworks use lists
          '.active-result', // Chosen/Select2
          '.wd-list-item' // Workday specific
        ];

        const possibleOptions = document.querySelectorAll(optionSelectors.join(', '));
        printLog(`Found ${possibleOptions.length} possible options in DOM`);

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
            input.value = value;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
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
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
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
    // Try common formats
    const datePatterns = [
      // yyyy-mm-dd (already ISO)
      { regex: /^(\d{4})-(\d{2})-(\d{2})$/, format: (m: RegExpMatchArray) => `${m[1]} -${m[2]} -${m[3]} ` },
      // mm/dd/yyyy or mm-dd-yyyy
      { regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/, format: (m: RegExpMatchArray) => `${m[3]} -${m[1].padStart(2, '0')} -${m[2].padStart(2, '0')} ` },
      // dd/mm/yyyy (European)
      { regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/, format: (m: RegExpMatchArray) => `${m[3]} -${m[2].padStart(2, '0')} -${m[1].padStart(2, '0')} ` },
      // Month dd, yyyy
      {
        regex: /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2}),? (\d{4})$/i, format: (m: RegExpMatchArray) => {
          const months: { [key: string]: string } = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
          return `${m[3]} -${months[m[1].toLowerCase().substring(0, 3)]} -${m[2].padStart(2, '0')} `;
        }
      },
    ];

    for (const pattern of datePatterns) {
      const match = value.match(pattern.regex);
      if (match) {
        const result = pattern.format(match);
        // Validate the result is a valid date
        const testDate = new Date(result);
        if (!isNaN(testDate.getTime())) {
          return result;
        }
      }
    }

    // Try JavaScript's native Date parsing as fallback
    const nativeDate = new Date(value);
    if (!isNaN(nativeDate.getTime())) {
      return nativeDate.toISOString().split('T')[0];
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
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Initialize form filler
const formFiller = new FormFiller();

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startFilling') {
    formFiller.startFilling().then(() => {
      sendResponse({ success: true });
    }).catch((error) => {
      sendResponse({ success: false, error: String(error) });
    });
    return true; // Keep channel open for async response
  }

  if (message.action === 'getStatus') {
    sendResponse({
      isRunning: formFiller['isRunning'],
      filledCount: formFiller['filledCount']
    });
  }
});

// Also expose a global function for manual triggering
(window as any).startFormFilling = () => {
  formFiller.startFilling();
};

printLog('Form filler content script loaded');

