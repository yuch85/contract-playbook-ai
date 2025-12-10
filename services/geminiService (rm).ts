
import { GoogleGenAI, Type } from "@google/genai";
import { Playbook, ShadowDocument, AnalysisFinding, RiskLevel, PlaybookRule } from '../types';
import { parseIR, mapIRToFindings } from './irParser';

/**
 * DEFAULT canonical taxonomy for playbook categories.
 * These are common to most contracts. LLM can ADD new categories if needed.
 * 
 * DESIGN: Extensible - start with these defaults, but LLM can propose
 * additional categories for domain-specific contracts (e.g., CLINICAL_TRIALS for pharma).
 */
export const DEFAULT_CATEGORIES = {
    LIABILITY: ['CAP', 'EXCLUSION', 'LIMITATION', 'INSURANCE'],
    INDEMNITY: ['SCOPE', 'PROCEDURE', 'CARVEOUTS', 'MUTUAL'],
    CONFIDENTIALITY: ['DEFINITION', 'OBLIGATIONS', 'TERM', 'EXCEPTIONS'],
    TERMINATION: ['FOR_CAUSE', 'FOR_CONVENIENCE', 'EFFECTS', 'SURVIVAL'],
    IP: ['OWNERSHIP', 'LICENSE', 'BACKGROUND', 'IMPROVEMENTS'],
    PAYMENT: ['TERMS', 'INVOICING', 'LATE_FEES', 'TAXES'],
    GOVERNING_LAW: ['JURISDICTION', 'VENUE', 'CHOICE_OF_LAW'],
    DISPUTE: ['ARBITRATION', 'MEDIATION', 'LITIGATION', 'ESCALATION'],
    DEFINITIONS: ['KEY_TERMS', 'SERVICES', 'DELIVERABLES'],
    BOILERPLATE: ['ASSIGNMENT', 'NOTICES', 'FORCE_MAJEURE', 'AMENDMENT', 'ENTIRE_AGREEMENT']
} as const;

/**
 * Generate proper rule ID from category + subcategory + index
 */
export const generateRuleId = (category: string, subcategory: string | undefined, index: number): string => {
    const cat = (category || 'GENERAL').toUpperCase().replace(/\s+/g, '_').substring(0, 12);
    const sub = subcategory ? `_${subcategory.toUpperCase().replace(/\s+/g, '_').substring(0, 8)}` : '';
    const num = String(index).padStart(2, '0');
    return `${cat}${sub}_${num}`;
};

/**
 * Normalize category - matches to defaults OR keeps custom category if reasonable.
 */
export const normalizeCategory = (raw: string): string => {
    const upper = (raw || '').toUpperCase().trim();
    
    // Direct match to defaults
    if (upper in DEFAULT_CATEGORIES) return upper;
    
    // Fuzzy matching for common variations
    const mappings: Record<string, string> = {
        'COMMERCIAL': 'PAYMENT',
        'LEGAL': 'GENERAL',
        'SCOPE': 'DEFINITIONS',
        'LIMITATION OF LIABILITY': 'LIABILITY',
        'INTELLECTUAL PROPERTY': 'IP',
        'WARRANTY': 'GENERAL', // Changed - not universal enough for its own category
        'PRIVACY': 'CONFIDENTIALITY', // Map to confidentiality rather than separate category
        'GDPR': 'CONFIDENTIALITY',
        'TERM': 'TERMINATION',
        'NDA': 'CONFIDENTIALITY',
        'NONDISCLOSURE': 'CONFIDENTIALITY',
    };
    
    for (const [pattern, category] of Object.entries(mappings)) {
        if (upper.includes(pattern)) return category;
    }
    
    // If it's a reasonable category name (not empty, not too long), keep it
    // This allows LLM to add domain-specific categories
    if (upper.length > 2 && upper.length < 30 && /^[A-Z_]+$/.test(upper)) {
        return upper;
    }
    
    return 'GENERAL';
};

/**
 * POST-PROCESSING: Clean and normalize raw LLM playbook output.
 * 
 * Fixes:
 * - Bad IDs ("IMPORTED_1") → Proper IDs ("LIABILITY_CAP_01")
 * - Bad categories ("COMMERCIAL Scope") → Canonical ("PAYMENT")
 * - Missing synonyms → Auto-generate from topic
 * - Missing keywords → Extract from topic + preferred text
 * - Empty risk criteria → Add sensible defaults
 */
export const postProcessPlaybookRules = (rules: PlaybookRule[]): PlaybookRule[] => {
    // Group by category to generate sequential IDs per category
    const categoryCounters: Record<string, number> = {};
    
    return rules.map((rule, globalIndex) => {
        // 1. Normalize category (maps fuzzy LLM names to canonical)
        const normalizedCategory = normalizeCategory(rule.category || 'GENERAL');
        
        // 2. Generate proper semantic ID
        const counter = (categoryCounters[normalizedCategory] || 0) + 1;
        categoryCounters[normalizedCategory] = counter;
        const rule_id = generateRuleId(normalizedCategory, rule.subcategory, counter);
        
        // 3. Ensure synonyms exist (auto-generate if LLM missed them)
        let synonyms = rule.synonyms || [];
        if (synonyms.length === 0 && rule.topic) {
            const topicLower = rule.topic.toLowerCase();
            synonyms = [
                rule.topic,
                topicLower,
                topicLower.replace(/\s+/g, ' ')
            ].filter((v, i, a) => a.indexOf(v) === i); // unique
        }
        
        // 4. Ensure signal_keywords exist (extract if missing)
        let signal_keywords = rule.signal_keywords || [];
        if (signal_keywords.length === 0) {
            const text = `${rule.topic} ${rule.preferred_position}`.toLowerCase();
            const words = text.match(/\b[a-z]{4,}\b/g) || [];
            signal_keywords = [...new Set(words)]
                .filter(w => !['this', 'that', 'with', 'from', 'shall', 'will', 'must'].includes(w))
                .slice(0, 5);
        }
        
        // 5. Ensure risk criteria are populated (add defaults if empty)
        const risk_criteria = {
            red: rule.risk_criteria?.red || 'Clause is missing or clearly adverse',
            yellow: rule.risk_criteria?.yellow || 'Clause exists but needs negotiation',
            green: rule.risk_criteria?.green || 'Clause meets preferred position'
        };
        
        return {
            ...rule,
            rule_id,
            category: normalizedCategory,
            synonyms,
            signal_keywords,
            risk_criteria
        };
    });
};

/**
 * IMMEDIATE USE: Quick heuristic classification of a clause.
 * 
 * HOW IT WORKS:
 * 1. Takes clause text + full playbook
 * 2. Scans for signal_keywords and synonyms in the clause
 * 3. Scores each category based on matches
 * 4. Returns top categories ranked by relevance
 * 
 * WHEN TO USE:
 * - Before calling LLM for contract analysis
 * - Pre-filter playbook to only relevant rules
 * - Reduces tokens by 80-95% (send 3-5 rules instead of 25)
 * 
 * PERFORMANCE: ~1-2ms per clause (pure JS, no API calls)
 */
export const classifyClauseLocally = (
    clauseText: string, 
    rules: PlaybookRule[]
): { category: string; matchingRules: PlaybookRule[]; score: number }[] => {
    const textLower = clauseText.toLowerCase();
    const scores: Map<string, { rules: PlaybookRule[]; score: number }> = new Map();
    
    for (const rule of rules) {
        const category = normalizeCategory(rule.category || 'GENERAL');
        let ruleScore = 0;
        
        // Check signal keywords (worth 2 points each)
        for (const kw of (rule.signal_keywords || [])) {
            if (textLower.includes(kw.toLowerCase())) {
                ruleScore += 2;
            }
        }
        
        // Check synonyms (worth 3 points each - stronger signal)
        for (const syn of (rule.synonyms || [])) {
            if (textLower.includes(syn.toLowerCase())) {
                ruleScore += 3;
            }
        }
        
        if (ruleScore > 0) {
            const existing = scores.get(category) || { rules: [], score: 0 };
            existing.rules.push(rule);
            existing.score += ruleScore;
            scores.set(category, existing);
        }
    }
    
    return Array.from(scores.entries())
        .map(([category, data]) => ({
            category,
            matchingRules: data.rules,
            score: data.score
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 5); // Return top 5 categories
};

const getClient = () => {
    return new GoogleGenAI({ apiKey: process.env.API_KEY || '' });
};

/**
 * Robust JSON parser that handles Markdown code blocks often returned by LLMs.
 */
const cleanAndParseJSON = (text: string, fallback: any = {}) => {
    try {
        if (!text) return fallback;
        let clean = text.trim();
        // Remove markdown code blocks (```json ... ```)
        clean = clean.replace(/^```json/i, '').replace(/^```/i, '');
        clean = clean.replace(/```$/, '');
        return JSON.parse(clean);
    } catch (e) {
        console.error("JSON Parse failed on text:", text);
        return fallback;
    }
};

// --- IR PARSING FOR PLAYBOOK RULES ---

const parseRuleIR = (text: string, originalRules: PlaybookRule[]): PlaybookRule[] => {
    console.log("--- START IR PARSE ---");
    console.log("Raw LLM Output Length:", text.length);

    const changes: PlaybookRule[] = [];
    
    // Regex to match: <<RULE id="ID">> BODY <<END_RULE>>
    const blockRegex = /<<RULE\s+id=["']([^"']+)["']\s*>>([\s\S]*?)<<END_RULE>>/g;
    
    let match;
    while ((match = blockRegex.exec(text)) !== null) {
        const id = match[1];
        const body = match[2];
        console.log(`Matched Block ID: ${id}`);
        
        // Strict ID Match
        const originalRule = originalRules.find(r => r.rule_id === id);

        if (!originalRule) {
            console.warn(`Skipping: Original rule not found for ID: ${id}. Ensure LLM is using rule_id, not Topic.`);
            continue;
        }
        
        const newRule = { ...originalRule };
        
        // Helper to extract [KEY] Value
        const extract = (key: string) => {
            const sectionRegex = new RegExp(`\\[${key}\\]([\\s\\S]*?)(?=\\[[A-Z_]+\\]|$)`, 'i');
            const m = body.match(sectionRegex);
            return m ? m[1].trim() : null;
        };
        
        const topic = extract('TOPIC');
        if (topic) newRule.topic = topic;
        
        const category = extract('CATEGORY');
        if (category) newRule.category = category;
        
        const preferred = extract('PREFERRED');
        if (preferred) newRule.preferred_position = preferred;
        
        const reasoning = extract('REASONING');
        if (reasoning) newRule.reasoning = reasoning;
        
        const fallback = extract('FALLBACK');
        if (fallback) newRule.fallback_position = fallback;
        
        const drafting = extract('DRAFTING');
        if (drafting) newRule.suggested_drafting = drafting;
        
        const red = extract('RISK_RED');
        const yellow = extract('RISK_YELLOW');
        const green = extract('RISK_GREEN');
        
        if (red || yellow || green) {
             newRule.risk_criteria = {
                red: red || newRule.risk_criteria.red,
                yellow: yellow || newRule.risk_criteria.yellow,
                green: green || newRule.risk_criteria.green
            };
        }
        
        changes.push(newRule);
    }
    
    console.log(`Total Changes Parsed: ${changes.length}`);
    console.log("--- END IR PARSE ---");
    return changes;
};


// Updated System Prompt for IR (Contract Analysis)
const SYSTEM_PROMPT = `You are a senior legal contract reviewer assistant. 
Your output must be in a custom INTERMEDIATE REPRESENTATION (IR) format.

STRICT FORMAT RULES:
1. For each NON-COMPLIANT clause, output a block wrapped in <<CLAUSE id="...">> and <<END_CLAUSE>> tags.
2. Inside the block, use [RISK], [ISSUE], [ORIGINAL], [REASONING], and [SUGGESTED_REWRITE] headers.
3. Do NOT use JSON. Do NOT use Markdown code blocks.
4. Output strictly natural language inside the sections.
5. If a clause is compliant, do NOT output anything for it.
6. CRITICAL: Analyze EVERY clause provided in the input text segment. Do not summarize, skip, or group clauses. 
7. Ensure every <<CLAUSE>> tag has a matching <<END_CLAUSE>>.

Example Output:
<<CLAUSE id="para_123">>
[RISK]
Red
[ISSUE]
Uncapped Liability
[ORIGINAL]
The Provider's liability shall be unlimited.
[REASONING]
This violates the playbook rule requiring a liability cap of 12 months fees.
[SUGGESTED_REWRITE]
The Provider's liability shall not exceed the fees paid in the preceding 12 months.
<<END_CLAUSE>>
`;

// Hybrid Batching Constants
const MAX_CHARS_PER_BATCH = 40000;

const createChunks = (document: ShadowDocument): string[] => {
    const chunks: string[] = [];
    let currentChunk = "";
    let currentClauseCount = 0;
    
    // Calculate average block size for dynamic batching
    if (document.paragraphs.length === 0) return [];
    
    const totalChars = document.paragraphs.reduce((sum, p) => sum + p.text.length, 0);
    const avgBlockSize = totalChars / document.paragraphs.length;
    
    // Dynamic clause limit based on average block size
    let dynamicMaxClauses: number;
    if (avgBlockSize < 200) {
        dynamicMaxClauses = 50; // Small blocks - allow more
    } else if (avgBlockSize < 500) {
        dynamicMaxClauses = 30; // Medium blocks
    } else {
        dynamicMaxClauses = 18; // Large blocks - fewer per batch
    }
    
    for (const p of document.paragraphs) {
        const pText = `<<CLAUSE id="${p.id}">>\n${p.text}\n<<END_CLAUSE>>\n\n`;
        const willExceedChars = (currentChunk.length + pText.length) > MAX_CHARS_PER_BATCH;
        const willExceedClauses = (currentClauseCount + 1) > dynamicMaxClauses;

        if ((willExceedChars || willExceedClauses) && currentChunk.length > 0) {
            chunks.push(currentChunk);
            currentChunk = "";
            currentClauseCount = 0;
        }
        
        currentChunk += pText;
        currentClauseCount++;
    }
    
    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }
    
    return chunks;
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function generateContentWithRetry(ai: GoogleGenAI, params: any, retries = 3): Promise<any> {
    try {
        return await ai.models.generateContent(params);
    } catch (e: any) {
        const msg = e.message || e.toString() || '';
        const isRateLimit = e.status === 429 || e.code === 429 || msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED');
        const isServerError = e.status === 500 || e.status === 503 || e.code === 500;

        if (retries > 0 && (isRateLimit || isServerError)) {
            const backoff = 2000 * Math.pow(2, 3 - retries);
            console.warn(`Gemini API Error (${e.status}). Retrying in ${backoff}ms...`);
            await delay(backoff);
            return generateContentWithRetry(ai, params, retries - 1);
        }
        throw e;
    }
}

// Helper for concurrent execution (Limit: 3 concurrent requests to avoid 429s)
const runWithConcurrencyLimit = async <T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> => {
    const results: T[] = [];
    const executing: Promise<void>[] = [];
    
    for (const task of tasks) {
        const p = task().then(result => {
            results.push(result);
        });
        executing.push(p);
        
        // Remove self from executing list when done
        p.finally(() => {
             const index = executing.indexOf(p);
             if (index > -1) executing.splice(index, 1);
        });

        if (executing.length >= limit) {
            await Promise.race(executing);
        }
    }
    await Promise.all(executing);
    return results;
};

export interface AnalysisTestConfig {
    temperature?: number;
    systemPromptOverride?: string;
    adversarialInstruction?: string;
}

export const analyzeDocumentWithGemini = async (
    document: ShadowDocument, 
    playbook: Playbook, 
    party: string,
    onProgress?: (msg: string) => void,
    testConfig?: AnalysisTestConfig,
    debugLog?: (key: string, data: any) => void
): Promise<AnalysisFinding[]> => {
    const ai = getClient();
    const chunks = createChunks(document);
    let allFindings: AnalysisFinding[] = [];
    const seenIds = new Set<string>(); // Track processed IDs
    const seenTextHashes = new Map<string, string>(); // Track text content to detect duplicates

    onProgress?.(`Splitting document into ${chunks.length} analysis batches...`);

    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        onProgress?.(`Analyzing batch ${i + 1} of ${chunks.length}...`);

        try {
            // Clean tags to get text for classification
            const chunkText = chunk.replace(/<<CLAUSE[^>]*>>/g, '').replace(/<<END_CLAUSE>>/g, '');
            const relevantCategories = classifyClauseLocally(chunkText, playbook.rules);
            
            // Check relevance threshold (Skip logic)
            // If the best category match score is < 4 (e.g. fewer than 2 keyword hits), we skip
            const maxScore = Math.max(...relevantCategories.map(c => c.score));
            if (maxScore < 4) {
                 console.log(`Skipping batch ${i} - low relevance score (${maxScore})`);
                 debugLog?.(`batch_${i}_skipped`, `Score: ${maxScore}`);
                 continue;
            }

            // Only send top matching rules to LLM
            const relevantRules = relevantCategories
                .flatMap(c => c.matchingRules)
                .slice(0, 5); // Max 5 rules instead of all 25!

            const rulesToUse = relevantRules.length > 0 ? relevantRules : playbook.rules.slice(0, 5);

            let prompt = `
REVIEW CONTEXT:
Role: Reviewing for ${party}.
Playbook Name: ${playbook.metadata.name}

RELEVANT PLAYBOOK RULES (pre-filtered for this section):
${rulesToUse.map(r => `Rule [${r.topic}]:
- Preferred: ${r.preferred_position}
- Red Flag: ${r.risk_criteria.red}
`).join('\n')}

DOCUMENT SEGMENT:
${chunk}
            `.trim();

            if (testConfig?.adversarialInstruction) {
                prompt += `\n\nINSTRUCTION: ${testConfig.adversarialInstruction}`;
            }

            const response = await generateContentWithRetry(ai, {
                model: 'gemini-2.5-flash',
                config: {
                    systemInstruction: testConfig?.systemPromptOverride || SYSTEM_PROMPT,
                    temperature: testConfig?.temperature ?? 0.1, 
                },
                contents: [{ role: 'user', parts: [{ text: prompt }] }]
            });

            const textResponse = response.text || "";
            
            if (debugLog) {
                debugLog(`batch_${i}_raw`, textResponse);
                debugLog(`batch_${i}_input_len`, chunk.length);
                debugLog(`batch_${i}_output_len`, textResponse.length);
            }

            const irClauses = parseIR(textResponse);
            const findings = mapIRToFindings(irClauses);

            for (const f of findings) {
                // Check 1: Have we seen this exact ID before?
                if (seenIds.has(f.target_id)) {
                    console.warn(`Skipping duplicate finding for ID: ${f.target_id}`);
                    continue;
                }
                
                // Check 2: Is this the same text content as another finding?
                // Use a simple hash of the original text to detect content duplicates
                // Hash: First 100 chars + Length (Simple but effective for exact text matches)
                const textHash = `${f.original_text.trim().toLowerCase().substring(0, 100)}_${f.original_text.length}`;
                const existingIdForText = seenTextHashes.get(textHash);
                
                if (existingIdForText && existingIdForText !== f.target_id) {
                    console.warn(`Skipping duplicate finding with same content. Original ID: ${existingIdForText}, Duplicate ID: ${f.target_id}`);
                    continue;
                }
                
                // Add to tracking sets
                seenIds.add(f.target_id);
                seenTextHashes.set(textHash, f.target_id);
                allFindings.push(f);
            }

        } catch (error) {
            console.error(`Batch ${i} failed:`, error);
        }
    }

    return allFindings;
};

// --- Test Utilities ---

export const createMockDocument = (count: number, complexity: 'simple' | 'mixed' | 'complex' | 'red_flag'): ShadowDocument => {
    const paragraphs = [];
    const simpleText = "The Provider shall limit its liability to the amount of fees paid."; 
    const complexText = "Notwithstanding anything to the contrary, the Provider's aggregate liability arising out of or related to this Agreement, whether in contract, tort (including negligence) or otherwise, shall be limited to the total amount paid by Customer to Provider under this Agreement in the twelve (12) month period preceding the event giving rise to the claim. This limit shall not apply to indemnification obligations for IP infringement.";
    const redFlagText = "The Provider shall have NO liability whatsoever for any damages, direct or indirect, arising under this Agreement.";

    for (let i = 0; i < count; i++) {
        let text = simpleText;
        if (complexity === 'complex') text = complexText;
        if (complexity === 'red_flag') text = redFlagText;
        if (complexity === 'mixed') text = i % 2 === 0 ? complexText : simpleText;

        paragraphs.push({
            id: `test_para_${i}`,
            text: `Clause ${i + 1}: ${text}`,
            style: 'Normal',
            outline_level: 0
        });
    }

    return {
        metadata: { filename: "Test_Doc.docx", timestamp: new Date().toISOString() },
        paragraphs
    };
};

// --- Party & Playbook Generation (kept as JSON) ---

export const detectPartiesFromDocument = async (document: ShadowDocument): Promise<string[]> => {
    const ai = getClient();
    const textSample = document.paragraphs.slice(0, 50).map(p => p.text).join('\n');
    
    try {
        const response = await generateContentWithRetry(ai, {
            model: 'gemini-2.5-flash',
            config: {
                responseMimeType: 'application/json',
                responseSchema: {
                    type: Type.ARRAY,
                    items: { type: Type.STRING }
                }
            },
            contents: [{ 
                role: 'user', 
                parts: [{ text: `Identify the contracting parties (e.g. "Customer", "Provider", "Buyer", "Seller") from this text. Return a JSON array of strings.\n\n${textSample}` }] 
            }]
        });
        
        const json = cleanAndParseJSON(response.text || "[]", []);
        return Array.isArray(json) ? json : ["Provider", "Customer"];
    } catch (e) {
        console.error("Party detection failed", e);
        return ["Provider", "Customer"];
    }
};

export const generatePlaybookFromDocument = async (
    document: ShadowDocument, 
    party: string, 
    onProgress?: (msg: string) => void
): Promise<Playbook> => {
    const ai = getClient();
    
    onProgress?.("Scanning document structure...");
    
    // SIMPLE APPROACH: Take first N substantial chunks
    // LLM will identify relevant categories from the document content itself
    // Keep clause structure so LLM can reference specific clauses for suggested_drafting
    const rawChunks = createChunks(document);
    const validChunks = rawChunks.filter(c => c.length > 500); // Filter tiny chunks
    
    // Take top 8 chunks (or all if fewer than 8)
    // LLM will scan these and can propose additional categories beyond DEFAULT_CATEGORIES
    const topChunks = validChunks.slice(0, 8);
    const selectedText = topChunks.join('\n\n---\n\n');
    
    onProgress?.("Extracting rules from prioritized sections...");

    // Suggest default categories but allow LLM to add contract-specific ones
    const suggestedCategories = Object.keys(DEFAULT_CATEGORIES).join(', ');
    
    // Step 1: Raw Rule Extraction
    const extractionPrompt = `Extract a contract playbook from this document for the "${party}".

CATEGORY TAXONOMY:
Use these DEFAULT CATEGORIES when applicable:
${suggestedCategories}

You may create NEW categories ONLY if:
1. The clause does NOT fit any existing default category (no overlap)
2. A new category would better capture the essence of the clause than forcing it into a default
3. The new category is reasonable and follows the naming convention (UPPERCASE_WITH_UNDERSCORES)

Examples of when to create new categories:
- Domain-specific: "CLINICAL_TRIALS", "DATA_PROCESSING", "REGULATORY_COMPLIANCE"
- When default categories are too generic for the specific legal concept

For each rule, provide:
- topic: Canonical name (e.g., "Liability Cap")
- category: Use a default category OR create a new one following the criteria above
- subcategory: Optional refinement (e.g., "CAP", "EXCLUSION")
- preferred_position: What ${party} wants
- reasoning: Business/legal justification
- fallback_position: Acceptable alternative
- suggested_drafting: Extract the EXACT clause text from the DOCUMENT section below.
  Each clause is marked with <<CLAUSE id="...">> tags. 
  
  RULES FOR EXTRACTION:
  1. Identify the clause ID(s) that this rule is based on (e.g., "docx_para_123")
  2. If the rule spans multiple neighboring clauses, combine them verbatim in order
  3. Copy the text EXACTLY as it appears in the document - do NOT paraphrase, summarize, or create new text
  4. You may make MINIMAL edits ONLY to align with preferred_position (e.g., change "Provider" to "Customer" if needed)
  5. If you must edit, clearly indicate what was changed from the source
  
  The goal is to use the actual document text as the foundation, not to create new drafting.
- risk_criteria: { red, yellow, green } thresholds
Return JSON with structure: { metadata, rules[] }
DOCUMENT:
${selectedText.substring(0, 30000)}`;

    try {
        const response = await generateContentWithRetry(ai, {
            model: 'gemini-2.5-flash',
            config: { 
                responseMimeType: 'application/json',
                temperature: 0.2
            },
            contents: [{ role: 'user', parts: [{ text: extractionPrompt }] }]
        });
        
        const rawPlaybook = cleanAndParseJSON(response.text || "{}", {}) as Playbook;
        
        // Step 2: Taxonomy & Structure Pass (LLM-based refinement)
        onProgress?.("Refining taxonomy and keywords...");
        const rules = rawPlaybook.rules || [];
        
        // Post-processing: normalize categories, generate IDs, ensure keywords
        const processedRules = postProcessPlaybookRules(rules);
        
        onProgress?.(`Finalized ${processedRules.length} rules`);
        
        return {
            metadata: { name: `${party} Playbook`, party },
            rules: processedRules
        };
    } catch (e) {
        console.error("Playbook gen failed", e);
        throw e;
    }
};

/**
 * NOTE: Name is legacy - we're NOT using embeddings.
 * This function now does POST-PROCESSING:
 * - Validates structure
 * - Normalizes categories
 * - Generates proper IDs
 * - Ensures synonyms/keywords exist
 */
export const enrichPlaybookWithEmbeddings = async (
    playbook: Playbook, 
    onProgress?: (msg: string) => void
): Promise<Playbook> => {
    onProgress?.("Validating and normalizing playbook structure...");
    
    // Post-processing: fix any bad data from import/generation
    const processedRules = postProcessPlaybookRules(playbook.rules || []);
    
    return { 
        ...playbook, 
        rules: processedRules 
    };
};

export const parsePlaybookFromText = async (
    text: string, 
    filename: string, 
    onProgress?: (msg: string) => void
): Promise<Playbook> => {
    const ai = getClient();
    onProgress?.("Parsing playbook file...");
    
    const suggestedCategories = Object.keys(DEFAULT_CATEGORIES).join(', ');
    
    const prompt = `Convert this text into a structured JSON Playbook.

CATEGORY TAXONOMY:
Use these DEFAULT CATEGORIES when applicable:
${suggestedCategories}

You may create NEW categories ONLY if:
1. The clause does NOT fit any existing default category (no overlap)
2. A new category would better capture the essence of the clause than forcing it into a default
3. The new category is reasonable and follows the naming convention (UPPERCASE_WITH_UNDERSCORES)

For each rule, provide all required fields including category, topic, preferred_position, risk_criteria, etc.
Output JSON matching: { metadata: { name, party }, rules: [...] }
TEXT:
${text.substring(0, 30000)}`;
    const response = await generateContentWithRetry(ai, {
        model: 'gemini-2.5-flash',
        config: { responseMimeType: 'application/json' },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    const rawPlaybook = cleanAndParseJSON(response.text || "{}", {}) as Playbook;
    
    // Post-processing: normalize and fix any issues
    const processedRules = postProcessPlaybookRules(rawPlaybook.rules || []);

    return {
        metadata: rawPlaybook.metadata || { name: filename, party: "Unknown" },
        rules: processedRules
    };
};

// --- Rule Refinement using IR (Fixes "No Changes" bug) ---

const REFINEMENT_IR_PROMPT = `You are an expert legal playbook architect.
Refine the contract playbook rules based on the user's instruction.

Output Format:
For each rule you modify, output a block in this strict format:

<<RULE id="RULE_ID">>
[TOPIC] Updated Topic
[CATEGORY] Updated Category
[PREFERRED] Updated Preferred Position
[REASONING] Updated Reasoning
[FALLBACK] Updated Fallback Position
[DRAFTING] Updated Suggested Drafting
[RISK_RED] Updated Red Flag Criteria
[RISK_YELLOW] Updated Yellow Flag Criteria
[RISK_GREEN] Updated Green Flag Criteria
<<END_RULE>>

Instructions:
1. Only include rules that require changes.
2. CRITICAL: You MUST use the 'rule_id' (e.g. "RULE_123", "INDEM_01") provided in the context as the identifier in the <<RULE id="...">> tag.
3. NEVER use the 'topic' text as the id. 
   - Incorrect: <<RULE id="Confidentiality">>
   - Correct:   <<RULE id="RULE_1">>
4. Output ALL fields for modified rules to ensure completeness.
5. Do NOT output Markdown code blocks or JSON.
`;

export const refinePlaybookRule = async (rule: PlaybookRule, instruction: string): Promise<PlaybookRule> => {
    const ai = getClient();
    
    // Ensure rule has ID
    const ruleWithId = { ...rule, rule_id: rule.rule_id || "SINGLE_RULE_01" };
    
    const prompt = `Refine this single playbook rule based on the instruction: "${instruction}".
    
    CURRENT RULE:
    ${JSON.stringify(ruleWithId, null, 2)}
    `;

    const response = await generateContentWithRetry(ai, {
        model: 'gemini-2.5-flash',
        config: { systemInstruction: REFINEMENT_IR_PROMPT },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });
    
    const changes = parseRuleIR(response.text || "", [ruleWithId]);
    return changes.length > 0 ? changes[0] : ruleWithId;
};

export const refinePlaybookGlobal = async (playbook: Playbook, instruction: string): Promise<Playbook> => {
    const ai = getClient();
    
    // Ensure all rules have stable IDs before sending to context
    const rulesWithIds = playbook.rules.map((r, i) => ({
        ...r,
        rule_id: r.rule_id || `RULE_${i + 1}`
    }));
    
    // Send full context so LLM knows what to change
    const fullContextRules = rulesWithIds.map(r => ({
        rule_id: r.rule_id, 
        topic: r.topic, 
        preferred_position: r.preferred_position,
        reasoning: r.reasoning,
        risk_criteria: r.risk_criteria,
        suggested_drafting: r.suggested_drafting,
        category: r.category,
        fallback_position: r.fallback_position
    }));
    
    const prompt = `I have a contract playbook with ${playbook.rules.length} rules.
    
    INSTRUCTION: "${instruction}"
    
    Analyze the rules and apply the instruction.
    Output ONLY the modified rules in the required IR format.
    
    CURRENT RULES (Use 'rule_id' as key):
    ${JSON.stringify(fullContextRules, null, 2)}
    `;

    const response = await generateContentWithRetry(ai, {
        model: 'gemini-2.5-flash',
        config: { systemInstruction: REFINEMENT_IR_PROMPT },
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
    });

    const changedRules = parseRuleIR(response.text || "", rulesWithIds);
    
    // Merge changes locally
    const newRules = rulesWithIds.map(r => {
        const change = changedRules.find(c => c.rule_id === r.rule_id);
        return change ? change : r;
    });

    return { ...playbook, rules: newRules };
};
