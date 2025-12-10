
import React, { useState } from 'react';
import { Playbook, PlaybookRule } from '../types';
import { Download, FileText, Zap, Sparkles, X, Wand2, Loader2, Save, Edit, ArrowLeftRight, RotateCcw } from 'lucide-react';
import { refinePlaybookRule, refinePlaybookGlobal } from '../services/geminiService';

interface PlaybookTableProps {
    playbook: Playbook;
    onUpdate: (updatedPlaybook: Playbook) => void;
}

// Access the global docx library loaded via script tag
declare var docx: any;

interface ModifiedState {
    originalMap: Record<string, PlaybookRule>; // rule_id -> original rule snapshot
    viewMode: Record<string, 'amended' | 'original'>; // rule_id -> current view
}

const PlaybookTable: React.FC<PlaybookTableProps> = ({ playbook, onUpdate }) => {
    // UI State for AI Modal
    const [aiTarget, setAiTarget] = useState<'global' | string | null>(null); // 'global' or rule_id
    const [aiPrompt, setAiPrompt] = useState('');
    const [isAiLoading, setIsAiLoading] = useState(false);
    
    // Track modifications for diff view
    const [modifiedState, setModifiedState] = useState<ModifiedState>({ originalMap: {}, viewMode: {} });

    // --- MANUAl EDIT HANDLERS ---
    
    const handleRuleChange = (index: number, field: keyof PlaybookRule, value: any) => {
        const newRules = [...playbook.rules];
        newRules[index] = { ...newRules[index], [field]: value };
        onUpdate({ ...playbook, rules: newRules });
    };

    const handleKeywordsChange = (index: number, value: string) => {
        const keywords = value.split(',').map(s => s.trim()).filter(s => s);
        handleRuleChange(index, 'signal_keywords', keywords);
    };

    const handleMetadataChange = (field: 'name' | 'party', value: string) => {
        onUpdate({
            ...playbook,
            metadata: {
                ...playbook.metadata,
                [field]: value
            }
        });
    };

    // --- AI HANDLERS ---

    const handleOpenAiModal = (target: 'global' | string) => {
        setAiTarget(target);
        setAiPrompt('');
        setIsAiLoading(false);
    };

    const handleAiSubmit = async () => {
        if (!aiPrompt.trim()) return;
        setIsAiLoading(true);
        try {
            if (aiTarget === 'global') {
                // Snapshot current rules before modification
                const snapshotMap: Record<string, PlaybookRule> = {};
                playbook.rules.forEach(r => { 
                    if (r.rule_id) snapshotMap[r.rule_id] = { ...r }; 
                });

                const updatedPlaybook = await refinePlaybookGlobal(playbook, aiPrompt);
                
                // Detect Changes and Populate Modified State
                const newModifiedState: ModifiedState = { 
                    originalMap: { ...modifiedState.originalMap }, 
                    viewMode: { ...modifiedState.viewMode } 
                };
                
                updatedPlaybook.rules.forEach(newRule => {
                    const ruleId = newRule.rule_id;
                    if (!ruleId) return;

                    const oldRule = snapshotMap[ruleId];
                    // Simple equality check
                    if (oldRule && JSON.stringify(newRule) !== JSON.stringify(oldRule)) {
                        // Only snapshot the original if we haven't already (preserves the "first" original)
                        if (!newModifiedState.originalMap[ruleId]) {
                            newModifiedState.originalMap[ruleId] = oldRule;
                        }
                        // Default to showing amended view
                        newModifiedState.viewMode[ruleId] = 'amended';
                    }
                });
                
                setModifiedState(newModifiedState);
                onUpdate(updatedPlaybook);

            } else if (typeof aiTarget === 'string') {
                const ruleIndex = playbook.rules.findIndex(r => r.rule_id === aiTarget);
                if (ruleIndex !== -1) {
                    const oldRule = playbook.rules[ruleIndex];
                    const updatedRule = await refinePlaybookRule(oldRule, aiPrompt);
                    
                    const newRules = [...playbook.rules];
                    newRules[ruleIndex] = updatedRule;
                    
                    // Track single modification
                    if (oldRule.rule_id) {
                         setModifiedState(prev => ({
                             originalMap: { 
                                 ...prev.originalMap, 
                                 [oldRule.rule_id!]: prev.originalMap[oldRule.rule_id!] || oldRule 
                             },
                             viewMode: { ...prev.viewMode, [oldRule.rule_id!]: 'amended' }
                         }));
                    }

                    onUpdate({ ...playbook, rules: newRules });
                }
            }
            setAiTarget(null); // Close modal
        } catch (e) {
            console.error(e);
            alert("AI Refinement failed. Please try again.");
        } finally {
            setIsAiLoading(false);
        }
    };

    const toggleRowView = (ruleId: string) => {
        setModifiedState(prev => ({
            ...prev,
            viewMode: {
                ...prev.viewMode,
                [ruleId]: prev.viewMode[ruleId] === 'original' ? 'amended' : 'original'
            }
        }));
    };

    const revertRow = (ruleId: string, index: number) => {
        const original = modifiedState.originalMap[ruleId];
        if (original) {
            const newRules = [...playbook.rules];
            newRules[index] = original;
            onUpdate({ ...playbook, rules: newRules });
            
            // Clear modification state for this row
            const newOriginalMap = { ...modifiedState.originalMap };
            delete newOriginalMap[ruleId];
            const newViewMode = { ...modifiedState.viewMode };
            delete newViewMode[ruleId];

            setModifiedState({ originalMap: newOriginalMap, viewMode: newViewMode });
        }
    };


    // --- EXPORT HANDLERS ---

    const handleExportJSON = () => {
        const dataStr = JSON.stringify(playbook, null, 2);
        const blob = new Blob([dataStr], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `${playbook.metadata.name.replace(/\s+/g, '_')}_Playbook.json`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
    };

    const handleExportDOCX = async () => {
        if (typeof docx === 'undefined') {
            alert("Export library is loading. Please try again in a moment.");
            return;
        }

        const { Document, Packer, Paragraph, Table, TableCell, TableRow, WidthType, TextRun, HeadingLevel, ShadingType, PageOrientation } = docx;

        // Helper to create a header cell with gray background
        const createHeaderCell = (text: string) => {
            return new TableCell({
                children: [new Paragraph({
                    children: [new TextRun({ text, bold: true, size: 24 })] // 24 = 12pt
                })],
                shading: { fill: "F3F4F6", type: ShadingType.CLEAR, color: "auto" },
                margins: { top: 100, bottom: 100, left: 100, right: 100 }
            });
        };

        // Helper to create a regular cell
        const createCell = (children: any[]) => {
            return new TableCell({
                children: children,
                margins: { top: 100, bottom: 100, left: 100, right: 100 }
            });
        };

        const tableRows = [
            new TableRow({
                tableHeader: true,
                children: [
                    createHeaderCell("ID"),
                    createHeaderCell("Category"),
                    createHeaderCell("Topic"),
                    createHeaderCell("Preferred Position"),
                    createHeaderCell("Reasoning"),
                    createHeaderCell("Fallback"),
                    createHeaderCell("Drafting"),
                ]
            })
        ];

        playbook.rules.forEach(rule => {
            tableRows.push(
                new TableRow({
                    children: [
                        createCell([new Paragraph({ text: rule.rule_id || "" })]),
                        createCell([
                            new Paragraph({ children: [new TextRun({ text: rule.category || "GEN", bold: true })] }),
                            new Paragraph({ children: [new TextRun({ text: rule.subcategory || "", size: 20, color: "666666" })] })
                        ]),
                        createCell([
                            new Paragraph({ children: [new TextRun({ text: rule.topic, bold: true })] }),
                            new Paragraph({ children: [new TextRun({ text: (rule.signal_keywords || []).slice(0,5).join(", "), italics: true, size: 18, color: "666666" })] })
                        ]),
                        createCell([new Paragraph({ text: rule.preferred_position })]),
                        createCell([new Paragraph({ text: rule.reasoning })]),
                        createCell([new Paragraph({ text: rule.fallback_position || "-" })]),
                        createCell([new Paragraph({ 
                            children: [new TextRun({ text: rule.suggested_drafting || "", font: "Courier New", size: 20 })] 
                        })]),
                    ]
                })
            );
        });

        const doc = new Document({
            sections: [{
                properties: {
                    page: {
                        size: {
                            orientation: PageOrientation.LANDSCAPE
                        }
                    }
                },
                children: [
                    new Paragraph({
                        text: playbook.metadata.name,
                        heading: HeadingLevel.HEADING_1,
                        spacing: { after: 200 }
                    }),
                    new Paragraph({
                        children: [
                            new TextRun({ text: "Party Role: ", bold: true }),
                            new TextRun(playbook.metadata.party)
                        ],
                        spacing: { after: 400 }
                    }),
                    new Table({
                        rows: tableRows,
                        width: { size: 100, type: WidthType.PERCENTAGE },
                    })
                ]
            }]
        });

        try {
            const blob = await Packer.toBlob(doc);
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${playbook.metadata.name.replace(/\s+/g, '_')}_Playbook.docx`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error("DOCX generation failed", e);
            alert("Failed to generate DOCX file.");
        }
    };

    return (
        <div className="bg-white rounded-lg shadow overflow-hidden flex flex-col h-full relative">
            {/* Toolbar */}
            <div className="p-4 border-b border-gray-200 flex justify-between items-center bg-gray-50 shrink-0">
                <div className="flex items-center gap-4 flex-1">
                    <div className="flex-1 max-w-lg space-y-2">
                        {/* Editable Name */}
                        <div className="flex items-center gap-2">
                            <input 
                                type="text"
                                className="text-xl font-bold text-gray-800 bg-transparent border border-transparent hover:border-gray-300 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100 rounded px-2 py-1 transition-all w-full"
                                value={playbook.metadata.name}
                                onChange={(e) => handleMetadataChange('name', e.target.value)}
                                placeholder="Playbook Name"
                            />
                            <Edit className="w-4 h-4 text-gray-400 opacity-50" />
                        </div>
                        {/* Editable Party */}
                        <div className="flex items-center gap-2">
                            <span className="text-sm text-gray-500 pl-2">Acting for:</span>
                            <input 
                                type="text"
                                className="text-sm font-semibold text-blue-600 bg-blue-50/50 border border-transparent hover:border-blue-300 focus:border-blue-500 focus:bg-white focus:ring-2 focus:ring-blue-100 rounded px-2 py-0.5 transition-all w-48"
                                value={playbook.metadata.party}
                                onChange={(e) => handleMetadataChange('party', e.target.value)}
                                placeholder="e.g. Provider"
                            />
                        </div>
                    </div>
                </div>
                <div className="flex gap-2">
                    <button 
                        onClick={() => handleOpenAiModal('global')}
                        className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-purple-500 to-indigo-600 hover:from-purple-600 hover:to-indigo-700 rounded text-white text-sm font-medium transition-all shadow-md"
                    >
                        <Sparkles className="w-4 h-4" /> AI Refine All
                    </button>
                    <div className="w-px h-8 bg-gray-300 mx-2"></div>
                    <button onClick={handleExportJSON} className="flex items-center gap-2 px-4 py-2 bg-white border border-gray-300 hover:bg-gray-50 rounded text-gray-700 text-sm font-medium transition-colors shadow-sm">
                        <Download className="w-4 h-4" /> JSON
                    </button>
                    <button onClick={handleExportDOCX} className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded text-white text-sm font-medium transition-colors shadow-sm">
                        <FileText className="w-4 h-4" /> DOCX
                    </button>
                </div>
            </div>

            {/* Editable Table */}
            <div className="overflow-auto flex-1 p-4 pb-20">
                <table className="min-w-full text-left text-sm border-separate border-spacing-0">
                    <thead className="bg-gray-100 text-gray-700 uppercase font-semibold sticky top-0 z-10 shadow-sm">
                        <tr>
                            <th className="px-4 py-3 border-b border-gray-200 w-12 text-center bg-gray-100">#</th>
                            <th className="px-4 py-3 border-b border-gray-200 w-32 bg-gray-100">Category</th>
                            <th className="px-4 py-3 border-b border-gray-200 w-48 bg-gray-100">Topic & Keywords</th>
                            <th className="px-4 py-3 border-b border-gray-200 w-64 bg-gray-100">Preferred Position</th>
                            <th className="px-4 py-3 border-b border-gray-200 w-64 bg-gray-100">Reasoning</th>
                            <th className="px-4 py-3 border-b border-gray-200 w-48 bg-gray-100">Fallback</th>
                            <th className="px-4 py-3 border-b border-gray-200 min-w-[250px] bg-gray-100">Drafting</th>
                            <th className="px-4 py-3 border-b border-gray-200 w-24 text-center sticky right-0 bg-gray-100 shadow-l">Act</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                        {playbook.rules.map((activeRule, idx) => {
                             const ruleId = activeRule.rule_id || '';
                             const isModified = !!modifiedState.originalMap[ruleId];
                             const viewMode = modifiedState.viewMode[ruleId] || 'amended';
                             
                             // Select which rule version to display based on view mode
                             const rule = (isModified && viewMode === 'original') 
                                ? modifiedState.originalMap[ruleId] 
                                : activeRule;

                             const isDisabled = isModified && viewMode === 'original';
                             const showModifiedHighlight = isModified && viewMode === 'amended';

                             return (
                                <tr key={idx} className={`group ${showModifiedHighlight ? 'bg-purple-50 hover:bg-purple-100' : 'hover:bg-blue-50/30'}`}>
                                    <td className="px-2 py-6 font-mono text-sm text-gray-400 text-center">{idx + 1}</td>
                                    
                                    {/* Category & Subcategory */}
                                    <td className="px-3 py-6 align-top">
                                        <input 
                                            type="text" 
                                            value={rule.category || ''}
                                            onChange={(e) => !isDisabled && handleRuleChange(idx, 'category', e.target.value)}
                                            className="w-full font-bold text-gray-800 bg-transparent border-none focus:ring-1 focus:ring-blue-500 rounded px-1 mb-2 placeholder-gray-300 disabled:opacity-50 text-sm"
                                            placeholder="CAT"
                                            disabled={isDisabled}
                                        />
                                        <input 
                                            type="text" 
                                            value={rule.subcategory || ''}
                                            onChange={(e) => !isDisabled && handleRuleChange(idx, 'subcategory', e.target.value)}
                                            className="w-full text-gray-500 bg-transparent border-none focus:ring-1 focus:ring-blue-500 rounded px-1 placeholder-gray-300 disabled:opacity-50 text-xs"
                                            placeholder="SUB"
                                            disabled={isDisabled}
                                        />
                                    </td>

                                    {/* Topic & Keywords */}
                                    <td className="px-3 py-6 align-top">
                                        <input 
                                            type="text" 
                                            value={rule.topic || ''}
                                            onChange={(e) => !isDisabled && handleRuleChange(idx, 'topic', e.target.value)}
                                            className="w-full font-medium text-gray-900 bg-transparent border-none focus:ring-1 focus:ring-blue-500 rounded px-1 mb-2 disabled:opacity-50 text-sm"
                                            disabled={isDisabled}
                                        />
                                        <textarea 
                                            rows={3}
                                            value={(rule.signal_keywords || []).join(', ')}
                                            onChange={(e) => !isDisabled && handleKeywordsChange(idx, e.target.value)}
                                            className="w-full text-xs text-blue-600 bg-blue-50/50 border-none focus:ring-1 focus:ring-blue-500 rounded px-1 resize-none disabled:opacity-50 min-h-[60px]"
                                            placeholder="Keywords..."
                                            disabled={isDisabled}
                                        />
                                    </td>

                                    {/* Preferred Position */}
                                    <td className="px-3 py-6 align-top">
                                        <textarea 
                                            rows={5}
                                            value={rule.preferred_position || ''}
                                            onChange={(e) => !isDisabled && handleRuleChange(idx, 'preferred_position', e.target.value)}
                                            className="w-full text-sm text-green-800 bg-green-50/30 border border-transparent focus:border-green-300 focus:bg-white focus:ring-1 focus:ring-green-500 rounded px-2 py-1 resize-y disabled:opacity-50 min-h-[100px] leading-relaxed"
                                            disabled={isDisabled}
                                        />
                                    </td>

                                    {/* Reasoning */}
                                    <td className="px-3 py-6 align-top">
                                        <textarea 
                                            rows={5}
                                            value={rule.reasoning || ''}
                                            onChange={(e) => !isDisabled && handleRuleChange(idx, 'reasoning', e.target.value)}
                                            className="w-full text-sm text-gray-600 italic bg-transparent border border-transparent focus:border-gray-300 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-2 py-1 resize-y disabled:opacity-50 min-h-[100px] leading-relaxed"
                                            disabled={isDisabled}
                                        />
                                    </td>

                                    {/* Fallback */}
                                    <td className="px-3 py-6 align-top">
                                        <textarea 
                                            rows={5}
                                            value={rule.fallback_position || ''}
                                            onChange={(e) => !isDisabled && handleRuleChange(idx, 'fallback_position', e.target.value)}
                                            className="w-full text-sm text-gray-700 bg-transparent border border-transparent focus:border-gray-300 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-2 py-1 resize-y disabled:opacity-50 min-h-[100px] leading-relaxed"
                                            disabled={isDisabled}
                                        />
                                    </td>

                                    {/* Drafting */}
                                    <td className="px-3 py-6 align-top">
                                        <textarea 
                                            rows={8}
                                            value={rule.suggested_drafting || ''}
                                            onChange={(e) => !isDisabled && handleRuleChange(idx, 'suggested_drafting', e.target.value)}
                                            className="w-full text-xs font-mono text-gray-700 bg-gray-50 border border-gray-200 focus:border-blue-300 focus:bg-white focus:ring-1 focus:ring-blue-500 rounded px-2 py-1 resize-y leading-relaxed disabled:opacity-50 min-h-[150px]"
                                            placeholder="Legal text..."
                                            disabled={isDisabled}
                                        />
                                    </td>

                                    {/* Row Actions */}
                                    <td className={`px-2 py-6 align-top text-center sticky right-0 border-l border-gray-100 ${showModifiedHighlight ? 'bg-purple-50' : 'bg-white group-hover:bg-blue-50/30'}`}>
                                        <div className="flex flex-col gap-2 items-center">
                                            <button 
                                                onClick={() => handleOpenAiModal(rule.rule_id || '')}
                                                className="p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 rounded-md transition-colors"
                                                title="AI Refine this Rule"
                                                disabled={isDisabled}
                                            >
                                                <Wand2 className="w-5 h-5" />
                                            </button>
                                            
                                            {isModified && (
                                                <div className="flex flex-col gap-1 w-full animate-in fade-in zoom-in duration-200">
                                                    <button 
                                                        onClick={() => toggleRowView(ruleId)}
                                                        className={`text-[10px] font-bold px-2 py-1 rounded border transition-colors
                                                            ${viewMode === 'amended' 
                                                                ? 'bg-purple-600 text-white border-purple-600 hover:bg-purple-700' 
                                                                : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                                                            }`}
                                                    >
                                                        {viewMode === 'amended' ? 'Amended' : 'Original'}
                                                    </button>
                                                     {viewMode === 'original' && (
                                                        <button 
                                                            onClick={() => revertRow(ruleId, idx)}
                                                            className="text-[10px] flex items-center justify-center gap-1 text-red-600 hover:text-red-700 hover:bg-red-50 py-1 rounded"
                                                            title="Revert to Original"
                                                        >
                                                            <RotateCcw className="w-3 h-3" /> Revert
                                                        </button>
                                                     )}
                                                </div>
                                            )}
                                        </div>
                                    </td>
                                </tr>
                             );
                        })}
                    </tbody>
                </table>
            </div>

            {/* AI Refinement Modal */}
            {aiTarget && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[70] flex items-center justify-center p-4">
                    <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden animate-in fade-in zoom-in duration-200">
                        <div className="bg-gradient-to-r from-purple-600 to-indigo-600 p-4 flex justify-between items-center text-white">
                            <h3 className="font-bold flex items-center gap-2">
                                <Sparkles className="w-5 h-5" />
                                {aiTarget === 'global' ? 'Refine Entire Playbook' : 'Refine Rule'}
                            </h3>
                            <button onClick={() => setAiTarget(null)} className="text-white/80 hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>
                        
                        <div className="p-6 bg-white">
                            <label className="block text-sm font-medium text-gray-700 mb-2">
                                {aiTarget === 'global' 
                                    ? "How should the AI modify the entire playbook?" 
                                    : "How should the AI modify this rule?"}
                            </label>
                            
                            <textarea 
                                autoFocus
                                className="w-full h-32 p-3 border border-gray-300 rounded-lg focus:ring-2 focus:ring-purple-500 focus:outline-none resize-none text-sm bg-white text-gray-900"
                                placeholder={aiTarget === 'global' 
                                    ? "e.g., Change all instances of 'Provider' to 'Consultant', and make liability caps mutual." 
                                    : "e.g., Make the fallback position more aggressive favoring the Customer."}
                                value={aiPrompt}
                                onChange={(e) => setAiPrompt(e.target.value)}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        handleAiSubmit();
                                    }
                                }}
                            />

                            <div className="mt-4 flex justify-end gap-3">
                                <button 
                                    onClick={() => setAiTarget(null)}
                                    className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg text-sm font-medium"
                                >
                                    Cancel
                                </button>
                                <button 
                                    onClick={handleAiSubmit}
                                    disabled={isAiLoading || !aiPrompt.trim()}
                                    className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-300 text-white rounded-lg text-sm font-medium transition-all"
                                >
                                    {isAiLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                                    {isAiLoading ? 'Refining...' : 'Generate Changes'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default PlaybookTable;
