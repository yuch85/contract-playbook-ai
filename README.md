# Contract Playbook Reviewer

A client-side, AI-powered contract review application built with React, TypeScript, and the Google Gemini API. This tool allows legal professionals to analyze contracts against a specific "Playbook" (a set of negotiation rules), generate new playbooks from existing documents, and redline contracts in a Microsoft Word-compatible editor.

[![Watch the video](https://img.youtube.com/vi/JCCNyjN34EE/maxresdefault.jpg)](https://www.youtube.com/watch?v=JCCNyjN34EE)


## 🚀 Key Features

*   **Playbook Generation**: Automatically extract negotiation rules, risk positions, and preferred clauses from an existing contract using Gemini 2.5 Flash.
*   **Automated Contract Review**: Analyzes uploaded documents (`.docx`, `.pdf`, `.json`) against a defined playbook to identify risks (Red/Yellow/Green).
*   **Interactive Redlining**: Review findings and apply AI-suggested text changes directly in a rich-text editor (Superdoc/ProseMirror).
*   **Microsoft Word Compatibility**:
    *   Parses raw `.docx` XML structure client-side.
    *   Exports reviewed documents back to `.docx` with formatting preserved.
*   **Split Architecture**: Decouples the document editing engine from the AI analysis logic for better performance.
*   **Robust AI Parsing**: Uses a custom **Intermediate Representation (IR)** parser to handle LLM outputs reliably, preventing JSON formatting errors common in long-context tasks.
*   **Local Pre-classification**: Heuristically filters relevant playbook rules before sending data to the LLM to save tokens and improve accuracy.

## 🛠️ Tech Stack

*   **Frontend**: React 19, TypeScript, Tailwind CSS
*   **AI Model**: Google Gemini 2.5 Flash (via `@google/genai` SDK)
*   **Editor Engine**: Superdoc (ProseMirror wrapper)
*   **Document Processing**:
    *   `jszip` & Custom XML Parsers (DOCX reading)
    *   `docx` (DOCX generation)
    *   `mammoth.js` (Fallback HTML conversion)
    *   `diff-match-patch` (Text comparison and redlining)
*   **Icons**: Lucide React

## 📦 Installation & Setup

### Prerequisites
*   Node.js (v18+)
*   A Google Cloud Project with the **Gemini API** enabled.
*   An API Key from [Google AI Studio](https://aistudio.google.com/).

### Steps

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/contract-playbook-reviewer.git
    cd contract-playbook-reviewer
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Configure Environment:**
    The application relies on `process.env.API_KEY` to authenticate with Gemini.
    
    Create a `.env` file in the root directory:
    ```env
    API_KEY=your_gemini_api_key_here
    ```
    *(Note: In a production client-side app, you should proxy requests through a backend to secure your API key. For this demo architecture, the key is used directly in the browser).*

4.  **Run the application:**
    ```bash
    npm start
    ```

## 📖 Usage Guide

### 1. Mode Selection
Upon launching, you can select between:
*   **Generate Playbook**: Upload a "Gold Standard" contract. The AI will extract rules (Liability Caps, Indemnity, etc.) and create a reusable playbook.
*   **Edit Playbook**: Upload an existing JSON or DOCX playbook to refine rules manually or using AI commands.
*   **Review Contract**: Upload a third-party contract to analyze it against your standard playbook.

### 2. The Review Process
1.  **Upload**: Drag and drop a `.docx` file.
2.  **Select Role**: Tell the AI if you are the "Provider" or "Customer".
3.  **Select Playbook**: Choose the ruleset to check against.
4.  **Analysis**: The app chunks the document, classifies clauses locally, and sends relevant sections to Gemini.
5.  **Review**:
    *   **Left Sidebar**: See a list of risks sorted by severity.
    *   **Center**: The document editor. Clicking a risk scrolls the relevant clause into view.
    *   **Right Sidebar**: See the AI's reasoning, the specific rule violation, and a suggested rewrite. You can "Accept" (apply redline) or "Reject" the finding.

## 🏗️ Architecture

### Core Services
*   **`geminiService.ts`**: Manages all LLM interactions. It includes the `generatePlaybookFromDocument` and `analyzeDocumentWithGemini` functions. It utilizes an **IR Parser** (`irParser.ts`) to convert natural language AI output into structured data, offering higher reliability than strict JSON mode.
*   **`wordAdapter.ts`**: A custom implementation that unzips `.docx` files in the browser, reads the `document.xml` and `numbering.xml`, and reconstructs the text and numbering styles into a "Shadow Document" structure used for analysis.
*   **`SuperdocEditor.tsx`**: Wraps the ProseMirror editor. It handles the **Position Mapping** and **Delta Tracking** logic (`diff-match-patch`). When AI suggests a change, the system maps the simple text replacement to granular insertions and deletions in the editor's node structure, ensuring robust Track Changes compatibility.

### Data Models
*   **`ShadowDocument`**: The lightweight JSON interface (defined in `types.ts`) used as the **Analysis Payload**. It represents a snapshot of the document state (paragraphs, metadata) sent to the AI service. It is distinct from the live editor state.
*   **`Playbook`**: A collection of `PlaybookRule` objects (Topic, Preferred Position, Risk Criteria).
*   **`AnalysisFinding`**: The result of an AI check, linking a specific paragraph ID to a risk assessment.

## 🧪 System Tests

The application includes a built-in **Test Suite Runner** (`TestSuiteRunner.tsx`). This allows developers to verify:
1.  **Parser Logic**: Checks if the IR parser correctly handles malformed tags or missing data.
2.  **Live LLM**: Runs a real request against Gemini to verify API connectivity and prompt adherence.
3.  **Batch Stress**: Tests the system's ability to handle large batches of clauses without hallucination.

To access the test suite, click the small "System Tests" button on the main upload screen.

## 📄 License

See LICENSE.MD
