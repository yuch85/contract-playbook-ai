# Contributing to AI Contract Playbook Reviewer

Welcome to the team! 👋

We’re building a high-performance, client-side legal AI tool that pushes the boundaries of what browser-based applications can do. Because this is a specialized, single-developer project, your contributions—whether they are user-facing features or deep engineering fixes—have an immediate and massive impact.

This guide outlines where we need help the most. We’ve organized tasks into **Features** (what users see) and **Engineering Challenges** (architectural improvements).

---

## 🚀 Features / Enhancements

These are high-impact additions that improve the workflow for legal professionals.

### **1. Comment after Tracked Changes**
**Goal:** When the LLM suggests an edit and the user accepts it, we currently apply the redline. We need to attach an external-facing comment explaining *why* the change was made.
*   **Task:** Implement logic to generate comments attached to the modified range.
*   **Detail:** Allow the system to set a specific author name (e.g., "AI Assistant" or "Legal Dept") for these comments so they look professional in Word.

### **2. Playbook Embeddings**
**Goal:** Improve the accuracy of clause matching.
*   **Current State:** We use keyword heuristics (`services/classifier.ts`).
*   **Task:** Re-enable and optimize vector embeddings for playbook rules. This allows the system to match a "Limitation of Liability" clause even if the contract calls it "Exclusions of Damages," based on semantic similarity rather than just exact words.

### **3. General LLM Chat Window**
**Goal:** Allow interactive dialogue with the document.
*   **Task:** Build a UI (sidebar or modal) where users can ask ad-hoc questions ("Does this contract have a non-solicit?") or instruct the AI to refine a specific finding interactively.

### **4. Undo button**
**Goal:** Allow AI applied edits to be undone.
*  **Task:** Put an Undo button in the side panel allowimg users to undo AI-applied edits. Investigate cleanest way to do it using Superdoc functionality or more long term to build a Viewer module using MVP approach.

---

## 🛠️ Technical / Engineering Challenges

These are complex tasks involving the core engine, data serialization, and backend architecture.

### **1. DOCX Export Stability** ✅ **RESOLVED**
**Goal:** Full-fidelity Word export.
*   **Status:** This issue has been resolved with our refactor away from custom clause nodes. By using Superdoc's native `sdBlockId` for block identification and storing metadata in React state rather than document attributes, we eliminated the need for aggressive document flattening. The export now works with standard document structures.
*   **Future Enhancement:** While basic export is stable, there may still be opportunities to improve preservation of complex formatting (tables, nested lists, headers) and ensure full compatibility with all Word features.

### **2. Intermediate Representation (IR) for Playbook Generation** (High Priority)
**Goal:** Move away from fragile JSON output for playbook generation.
*   **Current State:** We use a custom IR for *contract review* (`irParser.ts`), but *playbook generation* still relies on the LLM outputting raw JSON, which breaks on long documents.
*   **Task:** Update the playbook generation prompt and parser to use the robust `<<RULE>>...<<END_RULE>>` tag format, significantly improving reliability for large inputs.

### **3. LLM Call Optimization** (Medium Priority)
**Goal:** Improve performance and efficiency of LLM interactions.
*   **Current State:** LLM calls are processed sequentially in batches, which can be slow for large documents.
*   **Tasks:**
    *   Implement concurrent/parallel batch processing where API rate limits allow (requires amendment to deduplication logic to avoid race conditions)
    *   Optimize batch sizing based on token limits and API constraints
    *   Add request queuing and retry logic with exponential backoff
    *   Cache responses for identical inputs where appropriate
    *   Optimize prompt engineering to reduce token usage while maintaining accuracy
    *   **Party Detection Optimization:** Currently party detection runs only after user selects "Review Contract" mode, creating a blocking delay. Consider moving party detection to start immediately on file upload (background processing), with a lightweight contract check to avoid unnecessary LLM calls for non-contract documents. Cache results so they're ready when the user reaches party selection.

### **4. Multi-Provider LLM Architecture** (Medium Priority)
**Goal:** Decouple the app from Google Gemini.
*   **Task:** Refactor `services/geminiService.ts` into a provider-agnostic interface. 
*   **Future Proofing:** Implement support for OpenAI (GPT-4), Anthropic (Claude 3), or local models (Ollama). Ensure the architecture can handle different API signatures and token limits.

### **5. Human-Readable Clause References in AI Reasoning** (Medium to High Priority)
**Goal:** Replace UUIDs in AI-generated reasoning with human-readable clause numbers.
*   **Problem:** Currently, when the AI analyzes contracts, it references clauses by their UUID (e.g., "id: 68a669a9-4ff8-4f1a-ae57-221440b45182"), which is not meaningful to users. The AI reasoning should reference clauses by their actual document numbers (e.g., "Clause 2.1" or "Section 3").
*   **Current State:** After our refactor from custom clause nodes to Superdoc's native `sdBlockId`, we extract clauses from the Superdoc editor, which loses the original document structure metadata (outline levels, numbering prefixes) that was extracted by `wordAdapter.ts`.
*   **Preferred Approach:** Use the original `wordAdapter`-parsed document structure instead of extracting from Superdoc. The `wordAdapter` already accurately extracts:
    *   `outline_level` (0-9, from heading styles)
    *   `numberingPrefix` (calculated from Word's `numbering.xml` using native numbering definitions)
    *   `style` (e.g., "Heading 1", "Normal")
*   **Task:** 
    *   Store the original `wordAdapter`-parsed document when the file is loaded
    *   Use that document for analysis (it already has accurate structure metadata)
    *   Create a clause number map using the structure metadata (prefer `numberingPrefix`, fall back to `outline_level`-based inference, then sequential)
    *   Post-process AI reasoning output to replace UUIDs with human-readable clause numbers
    *   Map findings back to Superdoc blocks by text matching or position for UI highlighting
*   **Why This Approach:** More accurate than regex-based text parsing because it uses Word's native numbering definitions, handles all formats (decimal, roman, letters), preserves document hierarchy, and avoids edge cases from text pattern matching.

### **6. Multi-layer Tracked Changes**
**Goal:** Handle documents that already have tracked changes.
*   **Task:** Enhance the `SuperdocEditor` and `diff-match-patch` logic to recognize existing redlines. The AI should understand the *final* proposed text, not just the original text, and apply its new edits on top of (or replacing) previous human edits correctly.

### **7. Formatting Edge Cases**
**Goal:** Bulletproof document parsing.
*   **Task:** Improve `services/wordAdapter.ts` and the test suite to handle weird DOCX edge cases: floating images, text boxes, multi-column layouts, and nested fields.

---

## 💡 Guidelines & Best Practices

*   **Architecture:** We recently refactored away from custom clause nodes to use Superdoc's native `sdBlockId` for block identification. Metadata (risk levels, status) is now stored in React state rather than document attributes, keeping the document clean. The editor uses CSS classes applied dynamically based on state for styling.
*   **Modularity:** Keep AI logic (`services/geminiService.ts`) separate from UI logic (`components/`).
*   **Type Safety:** We use strict TypeScript. Ensure `types.ts` is updated if you change data models.
*   **Testing:** We rely heavily on `services/testSuiteService.ts`. If you touch the export logic or the parser, **run the tests** (`TestSuiteRunner`) to ensure no regressions.
*   **Editor Core:** The editor (`components/superdoc/`) is complex. Changes here usually require understanding ProseMirror transactions.

## Thank You!

Building a browser-based legal editor is hard. Your help makes it possible to keep this tool fast, private, and powerful. If you have questions, just ask in the issues or pull requests. Happy coding!
