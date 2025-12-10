
export enum RiskLevel {
  GREEN = 'green',
  YELLOW = 'yellow',
  RED = 'red',
}

export interface PlaybookRule {
  rule_id?: string; // Unique identifier (e.g. "LIAB_01")
  category?: string; // High-level category (e.g. "LIABILITY")
  subcategory?: string; // Granular sub-type (e.g. "CAP")
  topic: string; // Canonical Topic Name
  synonyms?: string[]; // phrases for mapping
  signal_keywords?: string[]; // keywords for heuristic scanning
  clause_number?: string; // e.g. "2.1"
  preferred_position: string;
  reasoning: string;
  fallback_position?: string;
  suggested_drafting?: string; // template
  risk_criteria: {
    green: string;
    yellow: string;
    red: string;
  };
}

export interface Playbook {
  metadata: {
    name: string;
    party: string;
  };
  rules: PlaybookRule[];
}

export interface Paragraph {
  id: string;
  text: string;
  original_text?: string; // Holds the pre-modification text for diffing
  style: string;
  outline_level: number;
  status?: 'original' | 'modified'; // Track if clause was amended
}

export interface ShadowDocument {
  metadata: {
    filename: string;
    timestamp: string;
  };
  paragraphs: Paragraph[];
}

export interface AnalysisFinding {
  target_id: string; // The GUID of the paragraph
  risk_level: RiskLevel;
  issue_type: string;
  reasoning: string;
  suggested_text: string; // The LLM proposed fix
  original_text: string; // Captured for diffing
  status?: 'open' | 'resolved' | 'ignored'; // Track workflow state
}

export type AppMode = 'review' | 'generate_playbook' | 'edit_playbook';

export interface ReviewSessionState {
  status: 'idle' | 'file_selected' | 'mode_selection' | 'detecting_parties' | 'party_selection' | 'playbook_selection' | 'processing_playbook' | 'generating_playbook' | 'scanning' | 'analyzing' | 'review_ready' | 'playbook_ready' | 'editor_debug' | 'error';
  mode: AppMode | null;
  uploadedFile: File | null;
  uploadedPlaybookFile: File | null; // For custom playbook
  userParty: string; // "Provider", "Customer", etc.
  detectedParties: string[]; // Parties detected by LLM
  document: ShadowDocument | null;
  findings: AnalysisFinding[];
  generatedPlaybook: Playbook | null;
  activeFindingId: string | null;
  progressMessage: string; // New field for visual updates
}
