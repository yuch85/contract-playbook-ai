import { PlaybookRule } from '../types';

/**
 * Step A: Keyword-based Pre-classification
 * Returns top 3 likely categories based on signal keywords and synonyms.
 */
export const detectLikelyCategories = (text: string, rules: PlaybookRule[]): string[] => {
    const lowerText = text.toLowerCase();
    const categoryScores: Record<string, number> = {};

    rules.forEach(rule => {
        // Fallback to "UNCATEGORIZED" or use rule.topic if category is missing
        const cat = rule.category || 'GENERAL';
        
        let score = 0;
        
        // Keywords (weight 2)
        rule.signal_keywords?.forEach(kw => {
            if (lowerText.includes(kw.toLowerCase())) score += 2;
        });
        
        // Synonyms (weight 3)
        rule.synonyms?.forEach(syn => {
             if (lowerText.includes(syn.toLowerCase())) score += 3;
        });

        if (score > 0) {
            categoryScores[cat] = (categoryScores[cat] || 0) + score;
        }
    });

    // Sort by score desc and take top 20 (Expanded window for larger chunks)
    return Object.entries(categoryScores)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 20)
        .map(([cat]) => cat);
};