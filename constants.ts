import { Playbook, ShadowDocument } from './types';

export const SAMPLE_PLAYBOOK: Playbook = {
  metadata: { name: "Standard SaaS Agreement", party: "Provider" },
  rules: [
    {
      rule_id: "INDEM_01",
      category: "INDEMNIFICATION",
      subcategory: "SCOPE",
      topic: "Indemnification",
      synonyms: ["hold harmless", "defend", "indemnity"],
      signal_keywords: ["indemnify", "claims", "damages", "losses"],
      preferred_position: "Mutual indemnification for IP infringement and gross negligence.",
      reasoning: "We must ensure liability is shared fairly.",
      risk_criteria: {
        green: "Mutual indemnification included.",
        yellow: "Unilateral but capped.",
        red: "Unilateral, uncapped, or missing provider protections."
      }
    },
    {
      rule_id: "LIAB_01",
      category: "LIABILITY",
      subcategory: "CAP",
      topic: "Limitation of Liability",
      synonyms: ["liability cap", "aggregate liability", "maximum liability"],
      signal_keywords: ["limit", "liability", "exceed", "paid"],
      preferred_position: "Cap at 12 months fees paid. Mutual.",
      reasoning: "To limit exposure to reasonable contract value.",
      risk_criteria: {
        green: "Capped at 12 months, mutual.",
        yellow: "Capped > 12 months or super caps exist.",
        red: "Unlimited liability or < 6 months cap."
      }
    },
    {
        rule_id: "GOV_01",
        category: "GOVERNING_LAW",
        subcategory: "JURISDICTION",
        topic: "Governing Law",
        synonyms: ["jurisdiction", "venue", "choice of law"],
        signal_keywords: ["laws of", "courts of", "governed by"],
        preferred_position: "State of Delaware or New York.",
        reasoning: "Standard commercial law jurisdictions.",
        risk_criteria: {
            green: "Delaware or New York.",
            yellow: "California or UK.",
            red: "Any other jurisdiction."
        }
    }
  ]
};

// This mocks the document that the Word Add-in would read
export const MOCK_DOC_CONTENT: ShadowDocument = {
  metadata: {
    filename: "Master_Services_Agreement_Draft_v2.docx",
    timestamp: new Date().toISOString()
  },
  paragraphs: [
    {
      id: "para_1",
      text: "1. INDEMNIFICATION",
      style: "Heading 1",
      outline_level: 1
    },
    {
      id: "para_2",
      text: "The Customer shall indemnify, defend and hold harmless the Provider against any and all claims, losses, and damages arising out of Customer's use of the Services.",
      style: "Normal",
      outline_level: 0
    },
    {
      id: "para_3",
      text: "2. LIMITATION OF LIABILITY",
      style: "Heading 1",
      outline_level: 1
    },
    {
      id: "para_4",
      text: "In no event shall Provider's liability arising out of or related to this Agreement exceed the total amount paid by Customer hereunder in the preceding three (3) months.",
      style: "Normal",
      outline_level: 0
    },
    {
        id: "para_5",
        text: "3. GOVERNING LAW",
        style: "Heading 1",
        outline_level: 1
    },
    {
        id: "para_6",
        text: "This Agreement shall be governed by the laws of the State of Texas.",
        style: "Normal",
        outline_level: 0
    }
  ]
};