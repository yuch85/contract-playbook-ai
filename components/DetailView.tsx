
import React, { useState, useEffect } from 'react';
import { AnalysisFinding } from '../types';
import DiffViewer from './DiffViewer';
import { Edit2, Check, X, Info } from 'lucide-react';

interface DetailViewProps {
  finding: AnalysisFinding;
  onAccept: (id: string, text: string) => void;
  onReject: (id: string) => void;
}

const DetailView: React.FC<DetailViewProps> = ({ finding, onAccept, onReject }) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editedText, setEditedText] = useState(finding.suggested_text);
  const isResolved = finding.status === 'resolved';

  // Reset local state when finding changes
  useEffect(() => {
    setIsEditing(false);
    
    const text = finding.suggested_text || "";
    // Normalize text to check for "no change" indicators
    const clean = text.trim().toLowerCase().replace(/[.,]/g, '');
    const noChangePhrases = [
        'no rewrite necessary', 
        'no changes required', 
        'no changes', 
        'no change',
        'none', 
        'n/a', 
        'no suggested rewrite',
        'compliant'
    ];
    
    // Check if the suggestion is effectively a "no-op"
    const isNoOp = noChangePhrases.some(p => clean === p || clean.startsWith('no changes')) || text.trim() === finding.original_text.trim();

    if (isNoOp) {
        // If no changes needed, revert to original text so DiffViewer shows no redlines
        setEditedText(finding.original_text);
    } else {
        setEditedText(text);
    }
  }, [finding]);

  const handleSave = () => {
    onAccept(finding.target_id, editedText);
  };

  const hasChanges = editedText.trim() !== finding.original_text.trim();

  return (
    <div className="flex flex-col h-full bg-white md:border-l border-gray-200 shadow-xl overflow-hidden w-full">
      {/* Header - Fixed Height */}
      <div className="p-4 border-b border-gray-100 bg-gray-50 shrink-0">
        <div className="flex justify-between items-start gap-2">
            <h2 className="text-lg font-bold text-gray-800 break-words">{finding.issue_type}</h2>
            {isResolved && <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-bold rounded-full border border-green-200 whitespace-nowrap">ACCEPTED</span>}
        </div>
      </div>

      {/* Content - Scrollable Area */}
      {/* Reasoning moved here to prevent cramping the layout */}
      <div className="p-4 flex-1 overflow-y-auto min-h-0 space-y-6">
        
        {/* AI Reasoning */}
        <div className="text-sm text-gray-600 bg-white p-3 rounded border border-gray-200 shadow-sm">
            <span className="font-semibold text-gray-900 block mb-1">AI Reasoning:</span>
            <span className="leading-relaxed">{finding.reasoning}</span>
        </div>
        
        {/* Diff / Editor Area */}
        <div className="space-y-2">
            <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-gray-500 uppercase tracking-wider">
                    {isEditing ? 'Editing Draft' : 'Proposed Changes'}
                </label>
                {!isEditing && !isResolved && (
                    <button 
                        onClick={() => setIsEditing(true)}
                        className="text-xs flex items-center gap-1 text-blue-600 hover:text-blue-700 font-medium px-2 py-1 rounded hover:bg-blue-50 transition-colors"
                    >
                        <Edit2 className="w-3 h-3" /> Manual Edit
                    </button>
                )}
            </div>

            {/* Informational Banner if No Changes */}
            {!hasChanges && !isEditing && (
                <div className="px-3 py-2 bg-blue-50 text-blue-700 text-xs rounded border border-blue-100 flex items-center gap-2">
                    <Info className="w-4 h-4 shrink-0" />
                    <span>AI suggests no changes to the text.</span>
                </div>
            )}

            {isEditing ? (
                <textarea
                    className="w-full h-64 p-3 text-sm border border-blue-300 rounded-md focus:ring-2 focus:ring-blue-500 focus:outline-none leading-relaxed resize-none font-serif"
                    value={editedText}
                    onChange={(e) => setEditedText(e.target.value)}
                />
            ) : (
                <div className={isResolved ? "opacity-50 pointer-events-none" : ""}>
                    <DiffViewer original={finding.original_text} proposed={editedText} />
                </div>
            )}
        </div>
      </div>

      {/* Footer Actions */}
      <div className="p-4 border-t border-gray-200 bg-gray-50 flex gap-3 sticky bottom-0 shrink-0">
        {!isResolved ? (
            <>
                <button
                    onClick={() => onReject(finding.target_id)}
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-100 transition-colors font-medium text-sm"
                >
                    <X className="w-4 h-4" />
                    Reject
                </button>
                <button
                    onClick={handleSave}
                    className={`flex-[2] flex items-center justify-center gap-2 px-4 py-2.5 text-white rounded-lg transition-colors shadow-sm font-medium text-sm
                        ${hasChanges ? 'bg-blue-600 hover:bg-blue-700' : 'bg-green-600 hover:bg-green-700'}`}
                >
                    <Check className="w-4 h-4" />
                    {isEditing ? 'Save & Apply' : (hasChanges ? 'Accept Change' : 'Mark Reviewed')}
                </button>
            </>
        ) : (
             <div className="flex gap-2 w-full">
                 <button
                    disabled
                    className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 bg-gray-100 text-gray-500 border border-gray-200 rounded-lg cursor-not-allowed font-medium text-sm"
                >
                    <Check className="w-4 h-4" />
                    Applied
                </button>
             </div>
        )}
      </div>
    </div>
  );
};

export default DetailView;
