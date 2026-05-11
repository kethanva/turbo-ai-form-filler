# Contributing to Auto Form Filler

First off, thank you for considering contributing to Auto Form Filler! It's people like you that make this tool better for everyone.

## Code of Conduct

By participating in this project, you are expected to uphold our Code of Conduct (be kind, be professional, be respectful).

## How Can I Contribute?

### Reporting Bugs

- **Check if the bug is already reported** by searching on GitHub under [Issues](../../issues).
- If you can't find an open issue that describes the problem, [open a new one](../../issues/new).
- Use a clear and descriptive title.
- Describe the exact steps which reproduce the problem.
- Include screenshots if it's a UI issue.
- Mention which ATS/site it was on (e.g., Workday, LinkedIn).

### Suggesting Enhancements

- [Open a new issue](../../issues/new) and describe the feature you'd like to see.
- Explain why this enhancement would be useful to most users.

### Pull Requests

1. **Fork the repo** and create your branch from `main`.
2. **If you've added code that should be tested, add tests.** (Testing suite coming soon).
3. **If you've changed APIs, update the documentation.**
4. **Ensure the build passes** (`npm run build`).
5. **Issue that PR!**

## Development Setup

```bash
git clone https://github.com/YOUR_USERNAME/auto-form-filler.git
cd auto-form-filler
npm install
npm run build
```

### Folder Structure

- `src/content.ts`: The main brain. Handles DOM scanning and filling.
- `src/modules/ai/`: LLM integration logic.
- `config/`: Prompt templates and example configurations.

## Style Guide

- Use TypeScript.
- Follow the existing indentation and naming conventions.
- Keep functions small and focused.
- Add comments for complex logic (especially DOM traversal).

## License

By contributing, you agree that your contributions will be licensed under its MIT License.
