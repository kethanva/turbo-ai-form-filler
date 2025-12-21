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

      // Fill each element
      for (const formElement of formElements) {
        await this.fillElement(formElement);
        // Small delay between fills
        await this.delay(500);
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

    // Find all input elements
    const inputs = document.querySelectorAll<HTMLInputElement>('input, textarea, select');
    printLog(`Found ${inputs.length} total input/textarea/select elements`);

    inputs.forEach((input) => {
      // Skip hidden, submit, button elements
      if (input.type === 'hidden' ||
        input.type === 'submit' ||
        input.type === 'button' ||
        input.type === 'reset' ||
        input.type === 'image') {
        return;
      }

      // Skip disabled or readonly inputs
      if (input.disabled || input.readOnly || input.getAttribute('readonly') !== null) {
        return;
      }

      // Skip hidden elements (CSS hidden or HTML hidden attribute)
      if (input.hidden ||
        input.getAttribute('hidden') !== null ||
        input.getAttribute('aria-hidden') === 'true' ||
        getComputedStyle(input).display === 'none' ||
        getComputedStyle(input).visibility === 'hidden') {
        return;
      }

      // Skip already checked checkboxes/radios
      if ((input.type === 'checkbox' && input.checked) ||
        (input.type === 'radio' && input.checked)) {
        return;
      }

      // For select elements, skip if a real (non-placeholder) option is already selected
      if (input.tagName.toLowerCase() === 'select') {
        const select = input as unknown as HTMLSelectElement;
        const selectVal = select.value.toLowerCase().trim();
        const selectedText = select.options[select.selectedIndex]?.text.toLowerCase().trim() || '';
        const selectLabel = this.extractQuestion(input);

        // Check if this is a placeholder value (not a real selection)
        const isPlaceholder = !selectVal || selectVal === '' ||
          selectVal === 'none' || selectVal === 'select' || selectVal === '-1' ||
          selectVal === '0' || selectVal === 'default' || selectVal === 'null' ||
          selectedText.includes('select') || selectedText.includes('choose') ||
          selectedText.includes('option') || selectedText.includes('please');

        printLog(`Select "${selectLabel}": value="${selectVal}", text="${selectedText}", isPlaceholder=${isPlaceholder}`);

        // Skip only if it's NOT a placeholder (meaning a real value is selected)
        if (!isPlaceholder) {
          printLog(`Skipping select "${selectLabel}" - already has real value selected`);
          return;
        }
      } else if (input.type !== 'checkbox' && input.type !== 'radio') {
        // For text-like input types, skip if already has a value
        // (Checkboxes and radios always have a value attribute that defines what gets submitted, 
        // not whether they're filled, so we don't skip them based on value)
        if (input.value && input.value.trim() !== '') {
          return;
        }
      }

      const question = this.extractQuestion(input);
      const options = this.extractOptions(input);

      elements.push({
        element: input,
        type: input.type || 'text',
        tagName: input.tagName.toLowerCase(),
        question,
        options
      });
    });

    return elements;
  }

  private extractQuestion(element: HTMLElement): string {
    // Try to find associated label
    let question = '';

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

    // Check for placeholder
    if (!question && 'placeholder' in element) {
      question = (element as HTMLInputElement).placeholder || '';
    }

    // Check for aria-label
    if (!question) {
      question = element.getAttribute('aria-label') || '';
    }

    // Check for name attribute
    if (!question) {
      question = element.getAttribute('name') || '';
    }

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
    }

    return options;
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
      const input = element as HTMLInputElement;

      printLog(`Filling element: ${question || 'Unknown field'}`);

      // Build enhanced question with format hints for date/time fields
      let enhancedQuestion = question || 'Form field';

      // For date fields, detect expected format from placeholder
      if (type === 'date' || type === 'text') {
        const placeholder = input.getAttribute('placeholder') || '';
        if (placeholder && (placeholder.toUpperCase().includes('MM') || placeholder.toUpperCase().includes('DD') || placeholder.toLowerCase().includes('date'))) {
          enhancedQuestion = `${enhancedQuestion} (format: ${placeholder})`;
        }
      }

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
        printLog(`No answer generated for: ${question}`);
        return;
      }

      // Fill the element based on type
      await this.setElementValue(element, type, answer, options);
      this.filledCount++;

      printLog(`✓ Filled: ${question} with: ${answer}`);
    } catch (error) {
      printLog(`Error filling element: ${error}`);
    }
  }

  private determineQuestionType(type: string, options?: string[]): string {
    if (type === 'radio') {
      return 'radio';
    } else if (type === 'checkbox') {
      return 'checkbox';
    } else if (type === 'select-one' || (type === 'select' && options && options.length > 0)) {
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
            printLog(`Using default donation amount: ${numVal}`);
          } else if (numQuestion.includes('quantity') || numQuestion.includes('qty') ||
            numQuestion.includes('count') || numQuestion.includes('number of')) {
            numVal = 1; // Default quantity
            printLog(`Using default quantity: ${numVal}`);
          } else if (numQuestion.includes('age') || numQuestion.includes('years')) {
            numVal = 25; // Default age
            printLog(`Using default age: ${numVal}`);
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
          printLog(`✓ Set number input to: ${numVal}`);
        } else {
          printLog(`⚠ Could not parse number from: ${value}`);
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

        printLog(`Date field: placeholder="${datePlaceholder}", expectedFormat="${expectedFormat}"`);

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
          if (input.type === 'date') {
            input.value = parsedDate;
          } else {
            input.value = formattedDate;
          }

          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          printLog(`✓ Set date to: ${input.value} (format: ${expectedFormat})`);
        } else {
          printLog(`⚠ Could not parse date: ${value}`);
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
          printLog(`⚠ Invalid color format: ${value}`);
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

        printLog(`Checkbox: label="${checkboxLabel.substring(0, 50)}...", isTerms=${isTermsCheckbox}, value="${value}", shouldCheck=${shouldCheck}`);
        if (shouldCheck) {
          const checkbox = input as HTMLInputElement;
          checkbox.checked = true;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
          checkbox.dispatchEvent(new Event('click', { bubbles: true }));
          checkbox.dispatchEvent(new Event('input', { bubbles: true }));
          printLog(`✓ Checked checkbox${isTermsCheckbox ? ' (auto-checked terms/conditions)' : ''}`);
        }
        break;

      case 'radio':
        // Find matching radio button by matching value to options
        printLog(`Radio: looking for "${value}" in options: ${JSON.stringify(options)}`);
        const name = input.getAttribute('name');
        if (name) {
          const radios = document.querySelectorAll<HTMLInputElement>(`input[type="radio"][name="${name}"]`);
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
            printLog(`⚠ No matching radio option found for: ${value}`);
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
            printLog(`Found exact match at index ${i}: "${opt.text}" (value: "${opt.value}")`);
            break;
          }

          // Check for partial match on text
          if (valLower.length >= 2 && optText.length >= 2) {
            if (optText.includes(valLower) || valLower.includes(optText)) {
              matchingOptionIndex = i;
              printLog(`Found text match at index ${i}: "${opt.text}" (value: "${opt.value}")`);
              break;
            }
          }

          // Check for partial match on value (supports country codes like "IN" for "India")
          if (valLower.length >= 2 && optValue.length >= 2) {
            if (optValue.includes(valLower) || valLower.includes(optValue)) {
              matchingOptionIndex = i;
              printLog(`Found value match at index ${i}: "${opt.text}" (value: "${opt.value}")`);
              break;
            }
          }

          // Check for partial match on id
          if (valLower.length >= 2 && optId.length >= 2) {
            if (optId.includes(valLower) || valLower.includes(optId)) {
              matchingOptionIndex = i;
              printLog(`Found id match at index ${i}: "${opt.text}" (id: "${opt.id}")`);
              break;
            }
          }

          // Check for partial match on label
          if (valLower.length >= 2 && optLabel.length >= 2) {
            if (optLabel.includes(valLower) || valLower.includes(optLabel)) {
              matchingOptionIndex = i;
              printLog(`Found label match at index ${i}: "${opt.text}" (label: "${opt.label}")`);
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
          printLog(`✓ Set select to option ${matchingOptionIndex}: ${select.options[matchingOptionIndex].text}`);
        } else {
          printLog(`⚠ No matching option found for value: ${value}`);
        }
        break;

      case 'select-multiple':
        const multiSelect = input as HTMLSelectElement;
        const values = value.split(',').map(v => v.trim().toLowerCase()).filter(v => v.length > 0);
        printLog(`Multi-select: looking for values: ${JSON.stringify(values)}`);

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
            printLog(`✓ Selected multi-select option ${idx}: "${option.text}"`);
          }
        });

        multiSelect.dispatchEvent(new Event('change', { bubbles: true }));
        multiSelect.dispatchEvent(new Event('input', { bubbles: true }));
        printLog(`Multi-select: selected ${selectedCount} options`);
        break;

      case 'file':
        // File inputs cannot be programmatically set for security reasons
        printLog('File input cannot be filled programmatically');
        break;

      case 'image':
        // Image inputs are typically submit buttons
        break;

      default:
        // For textarea and other elements
        if (input.tagName.toLowerCase() === 'textarea') {
          input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
        break;
    }
  }

  // Helper to parse various date formats to ISO (yyyy-mm-dd)
  private parseDateToISO(value: string): string | null {
    // Try common formats
    const datePatterns = [
      // yyyy-mm-dd (already ISO)
      { regex: /^(\d{4})-(\d{2})-(\d{2})$/, format: (m: RegExpMatchArray) => `${m[1]}-${m[2]}-${m[3]}` },
      // mm/dd/yyyy or mm-dd-yyyy
      { regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/, format: (m: RegExpMatchArray) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` },
      // dd/mm/yyyy (European)
      { regex: /^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/, format: (m: RegExpMatchArray) => `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` },
      // Month dd, yyyy
      {
        regex: /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* (\d{1,2}),? (\d{4})$/i, format: (m: RegExpMatchArray) => {
          const months: { [key: string]: string } = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
          return `${m[3]}-${months[m[1].toLowerCase().substring(0, 3)]}-${m[2].padStart(2, '0')}`;
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

