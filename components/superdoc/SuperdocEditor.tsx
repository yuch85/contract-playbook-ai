import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { getClauseExtension } from './extensions/ClauseExtension';
import { calculateWordDiff, DIFF_DELETE, DIFF_INSERT, DIFF_EQUAL } from '../../utils/diff';

interface SuperdocEditorProps {
    file: File | null;
    activeFindingId: string | null;
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
    exportDocument: (name: string) => Promise<void>;
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
            doc.descendants((node: any, pos: number, parent: any, index: number) => {
                if (node.type.name === 'clause' && node.attrs.id === clauseId) {
                    targetNode = node;
                    targetPos = pos;
                    targetIndex = index;
                    parentNode = parent;
                    return false;
                }
                return true;
            });
        } catch (e) {
            console.error("Error finding clause", e);
            return null;
        }

        if (!targetNode) {
            console.warn(`[ClauseAssembly] Clause ID ${clauseId} not found.`);
            return null;
        }

        const rawTargetText = extractNodeText(targetNode);

        let prevText = "";
        let nextText = "";
        let contextStart = targetPos;
        let contextEnd = targetPos + targetNode.nodeSize;
        let truncated = false;

        if (parentNode) {
            let charsCollected = 0;

            for (let i = 1; i <= prevClauses; i++) {
                const idx = targetIndex - i;
                if (idx < 0) break;

                const sibling = parentNode.child(idx);
                const text = extractNodeText(sibling);

                if (maxContextChars && (charsCollected + text.length) > maxContextChars) {
                    const remaining = maxContextChars - charsCollected;
                    if (remaining > 0) {
                        prevText = text.slice(-remaining) + "\n" + prevText;
                    }
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
                    if (remaining > 0) {
                        nextText += text.slice(0, remaining);
                    }
                    truncated = true;
                    break;
                } else {
                    nextText += text + "\n";
                    charsCollected += text.length;
                }
                contextEnd += sibling.nodeSize;
            }
        }

        const output: ClauseAssemblyOutput = {
            target: `<target_clause id="${clauseId}">${rawTargetText}</target_clause>`,
            context: `<context>${prevText.trim()}\n...\n${nextText.trim()}</context>`,
            metadata: {
                id: clauseId,
                startPos: targetPos,
                endPos: targetPos + targetNode.nodeSize,
                contextStart,
                contextEnd,
                truncated
            }
        };

        return output;
    };

    const runAssemblyTestSuite = async () => {
        console.log("Running Assembly Test Suite...");
    };

    useImperativeHandle(ref, () => ({
        exportDocument: async (filename: string) => {
            const editor = editorInstanceRef.current;
            if (!editor || !editor.activeEditor) {
                alert('Editor not initialized');
                return;
            }

            const safeName = filename.endsWith('.docx') ? filename : `${filename}.docx`;
            console.log(`[Superdoc] Attempting export of ${safeName}...`);


            try {
                const { state, view } = editor.activeEditor;

                console.log('� Preparing document for export...');

                // UNWRAP all clause nodes before export
                // Superdoc's DOCX exporter doesn't recognize custom 'clause' nodes
                const tr = state.tr;
                let modified = false;
                const nodesToUnwrap: Array<{ pos: number, node: any }> = [];

                // Collect all clause nodes (traverse in reverse for position stability)
                state.doc.descendants((node: any, pos: number) => {
                    if (node.type.name === 'clause') {
                        nodesToUnwrap.push({ pos, node });
                    }
                    return true;
                });

                console.log(`Found ${nodesToUnwrap.length} clause nodes to unwrap`);

                // Unwrap clauses (process in reverse to maintain positions)
                for (let i = nodesToUnwrap.length - 1; i >= 0; i--) {
                    const { pos, node } = nodesToUnwrap[i];
                    const from = pos;
                    const to = pos + node.nodeSize;

                    // Replace clause wrapper with its content
                    tr.replaceWith(from, to, node.content);
                    modified = true;
                }

                if (modified) {
                    view.dispatch(tr);
                    console.log('✓ Unwrapped clause nodes');
                    // Wait for DOM update
                    await new Promise(resolve => setTimeout(resolve, 100));
                }

                // Now export without clause wrappers
                console.log('🚀 Calling exportDocx...');
                const blob = await editor.activeEditor.exportDocx();

                if (!blob || !(blob instanceof Blob)) {
                    throw new Error('exportDocx did not return a valid Blob');
                }

                // Download the blob
                const url = window.URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = safeName;
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                window.URL.revokeObjectURL(url);

                console.log(`✅ Export successful: ${safeName}`);

            } catch (error: any) {
                console.error('❌ Export failed:', error);
                alert(`Failed to export document: ${error.message || 'Unknown error'}`);
            }
        },
        setDocumentContent: (html: string) => {
            const editor = editorInstanceRef.current;
            if (!editor) return;
            try { editor.activeEditor.commands.setContent(html); } catch (e) { }
        },
        applyTrackedChange: async (originalText: string, newText: string, attribution?: string): Promise<boolean> => {
            console.warn("Using deprecated applyTrackedChange. Use updateClause instead.");
            return false;
        },
        structureDocument: () => {
            const editor = editorInstanceRef.current;
            if (!editor || !editor.activeEditor) return;
            const pmEditor = editor.activeEditor;

            console.group("[Clause Model] Structuring Document");
            const { state, view } = pmEditor;

            if (!state.schema.nodes.clause) {
                console.error("CRITICAL: 'clause' node type missing from schema.");
                console.groupEnd();
                return;
            }

            const clauseType = state.schema.nodes.clause;
            if (typeof clauseType.spec.toDOM !== 'function') {
                clauseType.spec.toDOM = (node: any) => {
                    return ['div', {
                        'data-type': 'clause',
                        'class': 'sd-clause-node',
                        'data-clause-id': node.attrs.id,
                        'data-risk': node.attrs.risk || 'neutral',
                        'data-status': node.attrs.status || 'original'
                    }, 0];
                };
            }

            const nodesToWrap: { pos: number, node: any }[] = [];

            state.doc.content.forEach((node: any, offset: number) => {
                const absStart = offset + 1;
                if (node.isBlock && node.type.name !== 'clause') {
                    const hasText = node.textContent && node.textContent.trim().length > 0;
                    const isList = node.type.name.includes('List');
                    const isTable = node.type.name === 'table';
                    if (hasText || isList || isTable) {
                        nodesToWrap.push({ pos: absStart, node: node });
                    }
                }
            });

            if (nodesToWrap.length === 0) {
                console.warn("Structure: No blocks found to wrap.");
                console.groupEnd();
                return;
            }

            const tr = state.tr;
            let wrappedCount = 0;
            const Fragment = state.doc.content.constructor;

            for (let i = nodesToWrap.length - 1; i >= 0; i--) {
                const { pos, node } = nodesToWrap[i];
                const id = generateUUID();
                try {
                    const fragment = Fragment.from(node);
                    const clauseNode = clauseType.create({ id, status: 'original' }, fragment);
                    tr.replaceWith(pos, pos + node.nodeSize, clauseNode);
                    wrappedCount++;
                } catch (e) {
                    console.warn(`Failed to structure block at ${pos}. Skipping. Error:`, e);
                }
            }

            if (tr.docChanged) {
                try { view.dispatch(tr); } catch (e) { console.error("Dispatch failed:", e); }
            }
            console.log(`Successfully structured document. Processed ${wrappedCount} blocks.`);
            console.groupEnd();
        },
        getClauses: () => {
            const editor = editorInstanceRef.current;
            if (!editor || !editor.activeEditor) return [];
            const { state } = editor.activeEditor;
            const clauses: any[] = [];
            state.doc.descendants((node: any, pos: number) => {
                if (node.type.name === 'clause') {
                    clauses.push({
                        id: node.attrs.id,
                        text: extractNodeText(node),
                        risk: node.attrs.risk,
                        startPos: pos,
                        nodeSize: node.nodeSize
                    });
                    return false;
                }
                return true;
            });
            return clauses;
        },
        updateClause: async (clauseId: string, newText: string, attribution?: string): Promise<boolean> => {
            const editor = editorInstanceRef.current;
            if (!editor || !editor.activeEditor) return false;
            const { state, view } = editor.activeEditor;

            console.group(`[Diffing] Update Clause ${clauseId}`);

            let clausePos: number | null = null;
            let clauseNode: any = null;

            // Find the node
            state.doc.descendants((node: any, pos: number) => {
                if (node.type.name === 'clause' && node.attrs.id === clauseId) {
                    clausePos = pos;
                    clauseNode = node;
                    return false;
                }
                return true;
            });

            if (clausePos === null || !clauseNode) {
                console.error(`Clause node not found for ID: ${clauseId}`);
                // Diagnostic: Log all available clauses to help debug
                const availableIds: string[] = [];
                state.doc.descendants((node: any) => {
                    if (node.type.name === 'clause') {
                        availableIds.push(node.attrs.id);
                    }
                    return true;
                });
                console.log("Available Clause IDs in Document:", availableIds);
                console.groupEnd();
                return false;
            }

            // 1. Force Track Changes ON
            try {
                let modeEnabled = false;

                // Approach 1: Use editorInstance.setDocumentMode
                if (typeof editor.setDocumentMode === 'function') {
                    editor.setDocumentMode('suggesting');
                    console.log('✓ Track changes enabled via editor.setDocumentMode');
                    modeEnabled = true;
                }
                // Approach 2: Use window.superdoc (global instance)
                else if ((window as any).superdoc && (window as any).superdoc.setDocumentMode) {
                    (window as any).superdoc.setDocumentMode('suggesting');
                    console.log('✓ Track changes enabled via window.superdoc');
                    modeEnabled = true;
                }
                // Approach 3: Use editor.activeEditor.commands
                else if (editor.activeEditor?.commands?.trackChanges) {
                    editor.activeEditor.commands.trackChanges(true);
                    console.log('✓ Track changes enabled via commands');
                    modeEnabled = true;
                }

                if (!modeEnabled) {
                    console.warn('⚠️ Could not enable track changes - no method succeeded');
                }
            } catch (error) {
                console.error('Track changes enablement error:', error);
            }

            // 2. Build position map: extracted text index -> document position
            // This accounts for non-text nodes (run, etc.) between text nodes
            const positionMap: number[] = [];
            let textBuffer = '';

            clauseNode.descendants((node: any, pos: number) => {
                if (node.isText) {
                    const absolutePos = (clausePos as number) + 1 + pos;
                    const text = node.text || '';

                    for (let i = 0; i < text.length; i++) {
                        positionMap.push(absolutePos + i);
                    }
                    textBuffer += text;
                }
                return true;
            });

            if (positionMap.length === 0) {
                console.error('No text found in clause');
                console.groupEnd();
                return false;
            }

            const docText = textBuffer;

            console.log('Position map built:', {
                textLength: docText.length,
                mapLength: positionMap.length,
                firstPos: positionMap[0],
                lastPos: positionMap[positionMap.length - 1],
                first20Chars: docText.substring(0, 20)
            });

            // 3. Calculate Diff
            const diffs = calculateWordDiff(docText, newText);

            // 4. Apply diffs in a SINGLE TRANSACTION
            // ProseMirror handles position mapping automatically when all ops are in one transaction
            console.log('=== Starting Diff Application ===');
            console.log('Original text:', docText.substring(0, 100) + '...');
            console.log('New text:', newText.substring(0, 100) + '...');
            console.log('Total operations:', diffs.length);
            const { state: initialState, dispatch } = editor.activeEditor.view;
            let tr = initialState.tr;
            let textIndex = 0;  // Current index in extracted text
            let mapOffset = 0;  // Tracks position shift within this transaction
            diffs.forEach((part, opIndex) => {
                const token = part.text;

                console.log(`\n--- Operation ${opIndex + 1} ---`);
                console.log('Type:', part.op === DIFF_EQUAL ? 'EQUAL' : part.op === DIFF_DELETE ? 'DELETE' : 'INSERT');
                console.log('Token:', JSON.stringify(token.substring(0, 30) + (token.length > 30 ? '...' : '')));
                console.log('Text index:', textIndex, 'Map offset:', mapOffset);

                if (part.op === DIFF_EQUAL) {
                    textIndex += token.length;
                    console.log('→ Advanced text index to:', textIndex);
                }
                else if (part.op === DIFF_DELETE) {
                    const baseDocPos = positionMap[textIndex];
                    const endTextIndex = Math.min(textIndex + token.length - 1, positionMap.length - 1);
                    const baseEndDocPos = positionMap[endTextIndex] + 1;

                    // Apply offset from previous operations in this transaction
                    const actualDocPos = baseDocPos + mapOffset;
                    const actualEndDocPos = baseEndDocPos + mapOffset;

                    console.log('Deleting from', actualDocPos, 'to', actualEndDocPos);

                    // Add delete to transaction (don't dispatch yet!)
                    tr = tr.delete(actualDocPos, actualEndDocPos);

                    // Track offset: deletion reduces positions WITHIN this transaction
                    const deletedLength = actualEndDocPos - actualDocPos;
                    mapOffset -= deletedLength;
                    console.log('Map offset updated:', mapOffset + deletedLength, '→', mapOffset);

                    textIndex += token.length;
                }
                else if (part.op === DIFF_INSERT) {
                    const baseDocPos = textIndex < positionMap.length
                        ? positionMap[textIndex]
                        : positionMap[positionMap.length - 1] + 1;
                    const actualDocPos = baseDocPos + mapOffset;

                    console.log('Inserting at', actualDocPos, ':', JSON.stringify(token.substring(0, 20)));

                    // Add insert to transaction (don't dispatch yet!)
                    tr = tr.insertText(token, actualDocPos);

                    // Track offset: insertion increases positions WITHIN this transaction
                    mapOffset += token.length;
                    console.log('Map offset updated:', mapOffset - token.length, '→', mapOffset);

                    // DON'T advance textIndex (insert doesn't exist in original)
                }
            });
            // DISPATCH ONCE at the end - this is the key!
            console.log('\n=== Dispatching Single Transaction ===');
            console.log('Transaction steps:', tr.steps.length);
            dispatch(tr);
            console.log('\n=== Diff Application Complete ===');
            console.log('Final text index:', textIndex);
            console.log('Final map offset:', mapOffset);
            console.log('Expected text index:', docText.length);
            console.log('Match?', textIndex === docText.length);

            // 7. Update Node Status (Mark as pending review)
            // Use fresh transaction as well
            const { state: finalState, dispatch: finalDispatch } = editor.activeEditor.view;
            const finalTr = finalState.tr.setNodeMarkup(clausePos, undefined, { ...clauseNode.attrs, status: 'pending' });
            finalDispatch(finalTr);

            console.groupEnd();
            return true;
        },
        assembleClauseContext,
        runAssemblyTestSuite
    }));

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

    // Setup click listener for clearing selection
    useEffect(() => {
        if (!activeFindingId || !onClearSelection || status !== 'ready') return;

        const container = document.getElementById(CONTAINER_ID);
        const handleClick = (e: MouseEvent) => {
            // If the click is inside the editor but NOT on the active clause, clear selection.
            const target = e.target as HTMLElement;
            const clickedClause = target.closest('.sd-clause-node');

            // If we clicked ANY clause...
            if (clickedClause) {
                const clickedId = clickedClause.getAttribute('data-clause-id');
                // ...and it's not the currently active one
                if (clickedId !== activeFindingId) {
                    // Then we clear selection (so the user can edit the clicked clause or others)
                    console.log("Superdoc: Clicked inactive clause - clearing focus.");
                    onClearSelection();
                }
                // If it IS the active one, do nothing (keep focus)
            } else {
                // Clicked empty space or non-clause content -> clear selection
                // Make sure we aren't clicking the toolbar (if this listener is on the wrapper)
                // But here we are on the CONTAINER_ID which is the content area.
                console.log("Superdoc: Clicked editor background - clearing focus.");
                onClearSelection();
            }
        };

        if (container) {
            // Use capture to ensure we see the click even if ProseMirror stops propagation
            container.addEventListener('click', handleClick, true);
        }
        return () => {
            if (container) container.removeEventListener('click', handleClick, true);
        };
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
                    const ClauseExtension = getClauseExtension();
                    const extensions = ClauseExtension ? [ClauseExtension] : [];

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

    // Scroll to active clause when it changes
    useEffect(() => {
        if (!activeFindingId || status !== 'ready') return;

        const clauseElement = document.querySelector(`[data-clause-id="${activeFindingId}"]`);
        if (clauseElement) {
            clauseElement.scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });
        }
    }, [activeFindingId, status]);

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
  
  .sd-clause-node {
      border-left: 3px solid transparent;
      padding-left: 10px;
      margin-left: -13px;
      transition: all 0.3s ease;
      position: relative;
  }
  
  .sd-clause-node:hover {
      border-left-color: #cbd5e1;
      background-color: rgba(241, 245, 249, 0.3);
  }
  
  .sd-clause-node[data-risk="red"] {
      border-left-color: #ef4444;
      background-color: rgba(254, 226, 226, 0.2);
  }
  
  .sd-clause-node[data-status="pending"] {
      border-left-color: #f59e0b;
      background-color: rgba(255, 251, 235, 0.3);
  }
  
  /* ACTIVE CLAUSE HIGHLIGHTING */
  ${activeFindingId ? `
  .sd-clause-node:not([data-clause-id="${activeFindingId}"]) {
      opacity: 0.5;
      /* Removed pointer-events: none so clicks still register on the element 
         and bubble to our capture listener to clear selection */
  }
  
  .sd-clause-node[data-clause-id="${activeFindingId}"] {
      background-color: rgba(59, 130, 246, 0.15) !important;
      border-left-color: #3b82f6 !important;
      border-left-width: 5px !important;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
      opacity: 1 !important;
      margin: 16px 0;
  }
  ` : ''}
  
  @media (max-width: 640px) { .editor { padding: 1rem; min-height: 500px; } }
`}</style>
        </div>
    );
});

SuperdocEditor.displayName = 'SuperdocEditor';

export default SuperdocEditor;