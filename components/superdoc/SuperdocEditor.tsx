
import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { calculateWordDiff, DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL } from '../../utils/diff';
import { RiskLevel } from '../../types';

interface SuperdocEditorProps {
    file: File | null;
    activeFindingId: string | null;
    clauseMetadata?: Map<string, { risk: RiskLevel; status: string }>;
    user?: { name: string; email: string };
    readOnly?: boolean;
    onEditorReady?: () => void;
    onClearSelection?: () => void;
}

export interface ClauseContextOptions {
    prevClauses?: number;
    nextClauses?: number;
    maxContextChars?: number;
}

export interface ClauseAssemblyOutput {
    target: string;
    context: string;
    metadata: {
        id: string;
        startPos: number;
        endPos: number;
        contextStart: number;
        contextEnd: number;
        truncated: boolean;
    }
}

export interface SuperdocEditorHandle {
    exportDocument: (name: string) => Promise<boolean>;
    setDocumentContent: (html: string) => void;
    applyTrackedChange: (originalText: string, newText: string, attribution?: string) => Promise<boolean>;
    structureDocument: () => void;
    getClauses: () => any[];
    updateClause: (clauseId: string, newText: string, attribution?: string) => Promise<boolean>;
    assembleClauseContext: (clauseId: string, options?: ClauseContextOptions) => ClauseAssemblyOutput | null;
    runAssemblyTestSuite: () => Promise<void>;
}

const DEFAULT_USER = { name: 'Reviewer', email: 'reviewer@example.com' };

const SuperdocEditor = forwardRef<SuperdocEditorHandle, SuperdocEditorProps>(({
    file,
    activeFindingId,
    clauseMetadata,
    user = DEFAULT_USER,
    readOnly = false,
    onEditorReady,
    onClearSelection
}, ref) => {
    const editorInstanceRef = useRef<any>(null);
    const initTimerRef = useRef<any>(null);
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error' | 'missing_lib'>('idle');
    const [errorMessage, setErrorMessage] = useState('');

    const CONTAINER_ID = 'superdoc-editor-container';
    const TOOLBAR_ID = 'superdoc-toolbar';

    const generateUUID = () => {
        if (typeof crypto !== 'undefined' && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    };

    const extractNodeText = (node: any): string => {
        let text = "";
        if (node.isText) return node.text || "";
        if (node.content && node.content.forEach) {
            node.content.forEach((child: any) => {
                text += extractNodeText(child);
                if (child.isBlock) text += "\n";
            });
        }
        return text.trim();
    };

    // --- GLOBAL METADATA EXTENSION ---
    // Injects id, risk, and status attributes into standard blocks
    const getGlobalMetadataExtension = () => {
        const w = window as any;
        if (!w.SuperDocLibrary || !w.SuperDocLibrary.Extensions) return null;
        
        const { Extension } = w.SuperDocLibrary.Extensions;
        
        return Extension.create({
            name: 'globalMetadata',
            addGlobalAttributes() {
                return [
                    {
                        types: ['paragraph', 'heading', 'listItem', 'bulletList', 'orderedList'],
                        attributes: {
                            id: {
                                default: null,
                                parseHTML: (element: HTMLElement) => element.getAttribute('data-id'),
                                renderHTML: (attributes: any) => {
                                    if (!attributes.id) return {};
                                    return { 'data-id': attributes.id };
                                },
                            },
                            risk: {
                                default: null,
                                parseHTML: (element: HTMLElement) => element.getAttribute('data-risk'),
                                renderHTML: (attributes: any) => {
                                    if (!attributes.risk) return {};
                                    return { 'data-risk': attributes.risk };
                                },
                            },
                            status: {
                                default: 'original',
                                parseHTML: (element: HTMLElement) => element.getAttribute('data-status'),
                                renderHTML: (attributes: any) => {
                                    if (!attributes.status) return {};
                                    return { 'data-status': attributes.status };
                                },
                            }
                        },
                    },
                ];
            },
        });
    };

    const assembleClauseContext = (clauseId: string, options: ClauseContextOptions = {}): ClauseAssemblyOutput | null => {
        const editor = editorInstanceRef.current;
        if (!editor || !editor.activeEditor) return null;
        const { state } = editor.activeEditor;
        const { doc } = state;
        const { prevClauses = 1, nextClauses = 1, maxContextChars = 2000 } = options;

        let targetNode: any = null;
        let targetPos = -1;
        let targetIndex = -1;
        let parentNode: any = null;

        try {
            // Find node by native ID attribute
            doc.descendants((node: any, pos: number, parent: any, index: number) => {
                if (node.attrs.id === clauseId) {
                    targetNode = node;
                    targetPos = pos;
                    targetIndex = index;
                    parentNode = parent;
                    return false;
                }
                return true;
            });
        } catch (e) { console.error("Error finding clause", e); return null; }

        if (!targetNode) {
            console.warn(`[ClauseAssembly] Block ID ${clauseId} not found.`);
            return null;
        }

        const rawTargetText = extractNodeText(targetNode);
        let prevText = "";
        let nextText = "";
        let contextStart = targetPos;
        let contextEnd = targetPos + targetNode.nodeSize;
        let truncated = false;

        // Context assembly logic remains similar, but works on standard blocks
        if (parentNode) {
            let charsCollected = 0;
            for (let i = 1; i <= prevClauses; i++) {
                const idx = targetIndex - i;
                if (idx < 0) break;
                const sibling = parentNode.child(idx);
                const text = extractNodeText(sibling);
                if (maxContextChars && (charsCollected + text.length) > maxContextChars) {
                    const remaining = maxContextChars - charsCollected;
                    if (remaining > 0) prevText = text.slice(-remaining) + "\n" + prevText;
                    truncated = true;
                    break;
                } else {
                    prevText = text + "\n" + prevText;
                    charsCollected += text.length;
                }
                contextStart -= sibling.nodeSize;
            }
            charsCollected = 0;
            for (let i = 1; i <= nextClauses; i++) {
                const idx = targetIndex + i;
                if (idx >= parentNode.childCount) break;
                const sibling = parentNode.child(idx);
                const text = extractNodeText(sibling);
                if (maxContextChars && (charsCollected + text.length) > maxContextChars) {
                    const remaining = maxContextChars - charsCollected;
                    if (remaining > 0) nextText += text.slice(0, remaining);
                    truncated = true;
                    break;
                } else {
                    nextText += text + "\n";
                    charsCollected += text.length;
                }
                contextEnd += sibling.nodeSize;
            }
        }

        return {
            target: `<target_clause id="${clauseId}">${rawTargetText}</target_clause>`,
            context: `<context>${prevText.trim()}\n...\n${nextText.trim()}</context>`,
            metadata: { id: clauseId, startPos: targetPos, endPos: targetPos + targetNode.nodeSize, contextStart, contextEnd, truncated }
        };
    };

    const runAssemblyTestSuite = async () => { console.log("Running Assembly Test Suite..."); };

    useImperativeHandle(ref, () => ({
        exportDocument: async (filename: string): Promise<boolean> => {
            const editor = editorInstanceRef.current;
            if (!editor || !editor.activeEditor) {
                alert('Editor not initialized');
                return false;
            }

            const safeName = filename.endsWith('.docx') ? filename : `${filename}.docx`;
            console.log(`[Superdoc] Attempting native export of ${safeName}...`);

            try {
                // SIMPLIFIED EXPORT: Native export works because we use standard nodes.
                const exportedBlob = await editor.activeEditor.exportDocx();
                
                if (!exportedBlob || !(exportedBlob instanceof Blob)) {
                    throw new Error('exportDocx returned invalid blob');
                }

                const blob = new Blob([exportedBlob], { 
                    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" 
                });

                const url = window.URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = safeName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);
                console.log(`✅ Export successful`);
                return true;

            } catch (error: any) {
                console.error('❌ Export failed:', error);
                alert(`Export failed: ${error.message}`);
                return false;
            }
        },
        setDocumentContent: (html: string) => {
            const editor = editorInstanceRef.current;
            if (!editor) return;
            try { editor.activeEditor.commands.setContent(html); } catch (e) { }
        },
        applyTrackedChange: async (originalText: string, newText: string, attribution?: string): Promise<boolean> => {
            console.warn("Using deprecated applyTrackedChange.");
            return false;
        },
        structureDocument: () => {
            const editor = editorInstanceRef.current;
            if (!editor || !editor.activeEditor) return;
            const pmEditor = editor.activeEditor;
            const { state, view } = pmEditor;

            console.group("[Doc Structure] Assigning Native IDs");
            const tr = state.tr;
            let count = 0;

            // Iterate all blocks. If they don't have an ID, assign one.
            state.doc.descendants((node: any, pos: number) => {
                if (node.isBlock) {
                    const hasText = node.textContent && node.textContent.trim().length > 0;
                    const isList = node.type.name.includes('List') || node.type.name === 'listItem';
                    const isHeading = node.type.name === 'heading';

                    if ((hasText || isList || isHeading) && !node.attrs.id) {
                        const id = generateUUID();
                        // Only set if the schema allows the 'id' attribute (added by our GlobalMetadataExtension)
                        tr.setNodeMarkup(pos, undefined, { ...node.attrs, id, status: 'original' });
                        count++;
                    }
                }
                return true; // continue traversal
            });

            if (tr.docChanged) {
                view.dispatch(tr);
                console.log(`Assigned IDs to ${count} blocks.`);
            } else {
                console.log("Document already structured.");
            }
            console.groupEnd();
        },
        getClauses: () => {
            const editor = editorInstanceRef.current;
            if (!editor || !editor.activeEditor) return [];
            const { state } = editor.activeEditor;
            const clauses: any[] = [];
            const seenBlockIds = new Set<string>(); // Prevent duplicates
            
            // Extract all blocks with IDs
            state.doc.descendants((node: any, pos: number) => {
                if (node.attrs.id) {
                    // Skip if we've already processed this block ID (prevents recursion/traversal duplicates)
                    if (seenBlockIds.has(node.attrs.id)) {
                        return true;
                    }
                    seenBlockIds.add(node.attrs.id);

                    clauses.push({
                        id: node.attrs.id,
                        text: extractNodeText(node),
                        risk: node.attrs.risk,
                        startPos: pos,
                        nodeSize: node.nodeSize
                    });
                }
                return true;
            });
            return clauses;
        },
        updateClause: async (clauseId: string, newText: string, attribution?: string): Promise<boolean> => {
            const editor = editorInstanceRef.current;
            if (!editor || !editor.activeEditor) return false;
            
            console.group(`[Diffing] Update Block ${clauseId}`);
            const { state, view } = editor.activeEditor;
            let clausePos: number | null = null;
            let clauseNode: any = null;

            state.doc.descendants((node: any, pos: number) => {
                if (node.attrs.id === clauseId) {
                    clausePos = pos;
                    clauseNode = node;
                    return false;
                }
                return true;
            });

            if (clausePos === null || !clauseNode) {
                console.error(`Block node not found for ID: ${clauseId}`);
                console.groupEnd();
                return false;
            }

            // Enable Track Changes
            try {
                if (typeof editor.setDocumentMode === 'function') editor.setDocumentMode('suggesting');
                else if (editor.activeEditor?.commands?.trackChanges) editor.activeEditor.commands.trackChanges(true);
            } catch (error) { console.error('Track changes error:', error); }

            // Build Position Map
            const positionMap: number[] = [];
            let textBuffer = '';
            clauseNode.descendants((node: any, pos: number) => {
                if (node.isText) {
                    const absolutePos = (clausePos as number) + 1 + pos;
                    const text = node.text || '';
                    for (let i = 0; i < text.length; i++) { positionMap.push(absolutePos + i); }
                    textBuffer += text;
                }
                return true;
            });

            if (positionMap.length === 0) { console.error('No text in block'); console.groupEnd(); return false; }

            // Calculate Diff
            const diffs = calculateWordDiff(textBuffer, newText);
            const { state: initialState, dispatch } = editor.activeEditor.view;
            let tr = initialState.tr;
            let textIndex = 0;
            let mapOffset = 0;

            diffs.forEach((part) => {
                const token = part.text;
                if (part.op === DIFF_EQUAL) {
                    textIndex += token.length;
                } else if (part.op === DIFF_DELETE) {
                    const baseDocPos = positionMap[textIndex];
                    const endTextIndex = Math.min(textIndex + token.length - 1, positionMap.length - 1);
                    const baseEndDocPos = positionMap[endTextIndex] + 1;
                    const actualDocPos = baseDocPos + mapOffset;
                    const actualEndDocPos = baseEndDocPos + mapOffset;
                    tr = tr.delete(actualDocPos, actualEndDocPos);
                    mapOffset -= (actualEndDocPos - actualDocPos);
                    textIndex += token.length;
                } else if (part.op === DIFF_INSERT) {
                    const baseDocPos = textIndex < positionMap.length ? positionMap[textIndex] : positionMap[positionMap.length - 1] + 1;
                    const actualDocPos = baseDocPos + mapOffset;
                    tr = tr.insertText(token, actualDocPos);
                    mapOffset += token.length;
                }
            });

            dispatch(tr);
            
            // Mark Status as Pending
            const { state: finalState, dispatch: finalDispatch } = editor.activeEditor.view;
            // Note: We use the ID to find the node again as positions might have shifted
            let newPos = -1;
            finalState.doc.descendants((n: any, p: number) => { if (n.attrs.id === clauseId) { newPos = p; return false; } return true; });
            
            if (newPos !== -1) {
                const finalTr = finalState.tr.setNodeMarkup(newPos, undefined, { ...finalState.doc.nodeAt(newPos).attrs, status: 'pending' });
                finalDispatch(finalTr);
            }

            console.groupEnd();
            return true;
        },
        assembleClauseContext,
        runAssemblyTestSuite
    }));

    // Sync Clause Metadata (Styling)
    useEffect(() => {
        const editor = editorInstanceRef.current;
        if (!editor || !editor.activeEditor || !clauseMetadata) return;
        
        const { state, view } = editor.activeEditor;
        let tr = state.tr;
        let modified = false;

        // Traverse doc and apply risk/status attributes from metadata map
        state.doc.descendants((node: any, pos: number) => {
            const id = node.attrs.id;
            if (id && clauseMetadata.has(id)) {
                const meta = clauseMetadata.get(id);
                if (meta && (node.attrs.risk !== meta.risk || node.attrs.status !== meta.status)) {
                    tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, risk: meta.risk, status: meta.status });
                    modified = true;
                }
            }
            return true;
        });

        if (modified) {
            tr.setMeta('addToHistory', false); // Don't pollute undo stack with styling updates
            view.dispatch(tr);
        }

    }, [clauseMetadata]); // Re-run when metadata map changes

    const loadSuperdocScript = (): Promise<void> => {
        return new Promise((resolve, reject) => {
            const src = "https://unpkg.com/superdoc/dist/superdoc.umd.js";
            if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.crossOrigin = "anonymous";
            script.onload = () => resolve();
            script.onerror = (e) => reject(new Error("Failed to load Superdoc script"));
            document.head.appendChild(script);
        });
    };

    // Scroll to active clause
    useEffect(() => {
        if (!activeFindingId || status !== 'ready') return;
        // Use data-id selector (injected by our GlobalMetadataExtension)
        const clauseElement = document.querySelector(`[data-id="${activeFindingId}"]`);
        if (clauseElement) {
            clauseElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, [activeFindingId, status]);

    useEffect(() => {
        if (!activeFindingId || !onClearSelection || status !== 'ready') return;

        const container = document.getElementById(CONTAINER_ID);
        const handleClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            // Check for element with data-id
            const clickedBlock = target.closest('[data-id]');
            if (clickedBlock) {
                const clickedId = clickedBlock.getAttribute('data-id');
                if (clickedId !== activeFindingId) {
                    onClearSelection();
                }
            } else {
                onClearSelection();
            }
        };

        if (container) container.addEventListener('click', handleClick, true);
        return () => { if (container) container.removeEventListener('click', handleClick, true); };
    }, [activeFindingId, onClearSelection, status]);

    useEffect(() => {
        let isMounted = true;
        let retryCount = 0;
        const maxRetries = 100;
        const cleanup = () => {
            if (initTimerRef.current) { clearTimeout(initTimerRef.current); initTimerRef.current = null; }
            if (editorInstanceRef.current && typeof editorInstanceRef.current.destroy === 'function') {
                try { editorInstanceRef.current.destroy(); } catch (e) { }
                editorInstanceRef.current = null;
            }
        };
        cleanup();
        if (isMounted) setStatus('loading');

        const initEditor = async () => {
            const getCandidate = (obj: any) => {
                if (!obj) return null;
                if (obj instanceof HTMLElement) return null;
                if (obj['__reactFiber'] || String(Object.keys(obj)).includes('__react')) return null;
                return obj;
            };

            const checkLibrary = async () => {
                if (!isMounted) return;
                const w = window as any;
                const globalLib = getCandidate(w.SuperDocLibrary) || getCandidate(w.SuperDoc) || getCandidate(w.superdoc) || getCandidate(w.Superdoc);

                if (!globalLib) {
                    if (retryCount === 0) { try { await loadSuperdocScript(); } catch (e) { } }
                    if (retryCount < maxRetries) {
                        retryCount++;
                        initTimerRef.current = setTimeout(checkLibrary, 200);
                    } else {
                        if (isMounted) setStatus('missing_lib');
                    }
                    return;
                }

                if (w.SuperDocLibrary && !w.SuperDocLibrary.Extensions) {
                    if (retryCount < maxRetries) {
                        retryCount++;
                        initTimerRef.current = setTimeout(checkLibrary, 200);
                        return;
                    }
                }

                let Constructor: any = null;
                if (typeof globalLib === 'function') Constructor = globalLib;
                else if (typeof globalLib === 'object') {
                    if (typeof globalLib.SuperDoc === 'function') Constructor = globalLib.SuperDoc;
                    else if (typeof globalLib.default === 'function') Constructor = globalLib.default;
                    else {
                        const keys = Object.keys(globalLib);
                        for (const key of keys) {
                            if (key.match(/^[A-Z]/) && typeof globalLib[key] === 'function') {
                                Constructor = globalLib[key];
                                break;
                            }
                        }
                    }
                }

                if (!Constructor) { if (isMounted) setStatus('error'); return; }

                try {
                    const containerEl = document.getElementById(CONTAINER_ID);
                    if (containerEl) containerEl.innerHTML = '';
                    
                    // Use GlobalMetadataExtension instead of ClauseExtension
                    const MetadataExt = getGlobalMetadataExtension();
                    const extensions = MetadataExt ? [MetadataExt] : [];

                    const config: any = {
                        selector: `#${CONTAINER_ID}`,
                        toolbar: `#${TOOLBAR_ID}`,
                        documentMode: readOnly ? 'viewing' : 'editing',
                        pagination: true,
                        rulers: true,
                        user: user,
                        editorExtensions: extensions,
                        modules: {
                            comments: { readOnly: readOnly, allowResolve: true },
                            trackChanges: { enabled: true }
                        },
                        onReady: () => {
                            console.log("Superdoc reported Ready");
                            if (isMounted) {
                                setStatus('ready');
                                if (onEditorReady) onEditorReady();
                            }
                        }
                    };

                    if (file) {
                        console.log("Loading file into Superdoc:", file.name);
                        config.document = file;
                    }

                    const editor = new Constructor(config);
                    editorInstanceRef.current = editor;

                } catch (err: any) {
                    console.error("Editor Init Error:", err);
                    if (isMounted) {
                        setStatus('error');
                        setErrorMessage(err.message || "Initialization failed");
                    }
                }
            };
            checkLibrary();
        };
        initTimerRef.current = setTimeout(initEditor, 100);
        return () => { isMounted = false; cleanup(); };
    }, [file, readOnly, user]);

    if (status === 'missing_lib') return <div>Superdoc Library Not Found</div>;
    if (status === 'error') return <div>Editor Error: {errorMessage}</div>;

    return (
        <div className="document-editor w-full h-full flex flex-col relative overflow-hidden bg-gray-100">
            {status === 'loading' && (
                <div className="absolute inset-0 flex items-center justify-center bg-white/80 z-20">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                    <span className="ml-2 font-medium text-gray-600">Loading Editor...</span>
                </div>
            )}
            <div id={TOOLBAR_ID} className="toolbar border-b border-gray-200 bg-white shadow-sm shrink-0 min-h-[40px]"></div>
            <div className="superdoc-container flex-1 overflow-auto relative bg-gray-200 flex justify-center p-4">
                <div
                    id={CONTAINER_ID}
                    className="editor bg-white shadow-md min-h-[800px] w-full max-w-[850px]"
                    style={{ cursor: 'text', touchAction: 'manipulation' }}
                ></div>
            </div>
            <style>{`
  .document-editor { display: flex; flex-direction: column; height: 100%; width: 100%; }
  .toolbar { flex: 0 0 auto; border-bottom: 1px solid #eee; }
  .superdoc-container { flex: 1 1 auto; min-height: 0; }
  .editor { padding: 2.5rem; }
  .super-editor, .ProseMirror { color: #000 !important; }
  
  /* NATIVE BLOCK STYLING via attributes */
  
  /* Base style for any block with an ID */
  [data-id] {
      border-left: 3px solid transparent;
      padding-left: 10px;
      margin-left: -13px;
      transition: all 0.3s ease;
      position: relative;
  }
  
  [data-id]:hover {
      border-left-color: #cbd5e1;
      background-color: rgba(241, 245, 249, 0.3);
  }
  
  /* Risk Levels */
  [data-risk="red"] {
      border-left-color: #ef4444;
      background-color: rgba(254, 226, 226, 0.2);
  }
  [data-risk="yellow"] {
      border-left-color: #f59e0b;
      background-color: rgba(255, 251, 235, 0.2);
  }
  
  /* Status */
  [data-status="pending"] {
      /* Highlight pending changes */
      background-color: rgba(255, 251, 235, 0.4);
  }
  
  /* Active Finding Highlight */
  ${activeFindingId ? `
  [data-id]:not([data-id="${activeFindingId}"]) {
      opacity: 0.6;
  }
  
  [data-id="${activeFindingId}"] {
      background-color: rgba(59, 130, 246, 0.15) !important;
      border-left-color: #3b82f6 !important;
      border-left-width: 5px !important;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
      opacity: 1 !important;
  }
  ` : ''}
  
  @media (max-width: 640px) { .editor { padding: 1rem; min-height: 500px; } }
`}</style>
        </div>
    );
});

SuperdocEditor.displayName = 'SuperdocEditor';

export default SuperdocEditor;
