import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { ReviewSessionState, AnalysisFinding, AppMode, Playbook } from './types';
import { wordAdapter } from './services/wordAdapter';
import { analyzeDocumentWithGemini, generatePlaybookFromDocument, detectPartiesFromDocument, parsePlaybookFromText, enrichPlaybookWithEmbeddings } from './services/geminiService';
import RiskCard from './components/RiskCard';
import DetailView from './components/DetailView';
import FileUpload from './components/FileUpload';
import PlaybookEditor from './components/PlaybookEditor';
import SuperdocEditor, { SuperdocEditorHandle } from './components/superdoc/SuperdocEditor';
import TestSuiteRunner from './components/TestSuiteRunner';
import SettingsModal, { AppSettings } from './components/SettingsModal';
import { FileText, RotateCcw, CheckCircle2, ChevronRight, BookOpen, Loader2, Plus, Upload, Settings, Download, Bug, Layout, ScanEye, Wand2, Edit3, TestTube, Menu, X } from 'lucide-react';

export default function App() {
    const [session, setSession] = useState<ReviewSessionState>({
        status: 'idle',
        mode: null,
        uploadedFile: null,
        uploadedPlaybookFile: null,
        userParty: 'Provider',
        detectedParties: [],
        document: null,
        findings: [],
        generatedPlaybook: null,
        activeFindingId: null,
        progressMessage: ''
    });

    const [manualPartyInput, setManualPartyInput] = useState("");
    const [showManualInput, setShowManualInput] = useState(false);
    const [debugClauses, setDebugClauses] = useState<any[]>([]);
    const [showTestRunner, setShowTestRunner] = useState(false);
    const [isEditorReady, setIsEditorReady] = useState(false);
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

    // Settings State
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);
    const [appSettings, setAppSettings] = useState<AppSettings>({});

    // Editor Ref
    const editorRef = useRef<SuperdocEditorHandle>(null);

    // Memoize user object to prevent Editor re-initialization on state updates
    const editorUser = useMemo(() => ({
        name: session.userParty,
        email: 'reviewer@example.com'
    }), [session.userParty]);

    // Load Settings on Mount
    useEffect(() => {
        const saved = localStorage.getItem('contract_ai_settings');
        if (saved) {
            try {
                setAppSettings(JSON.parse(saved));
            } catch (e) {
                console.error("Failed to load settings", e);
            }
        }
    }, []);

    const handleSaveSettings = (newSettings: AppSettings) => {
        setAppSettings(newSettings);
        localStorage.setItem('contract_ai_settings', JSON.stringify(newSettings));
    };

    // 1. File Upload Handler
    const handleFileSelected = (file: File) => {
        if (session.status === 'editor_debug') {
            setSession(prev => ({
                ...prev,
                uploadedFile: file
            }));
            return;
        }

        setSession(prev => ({
            ...prev,
            status: 'mode_selection',
            uploadedFile: file
        }));
        // Reset editor readiness when new file is loaded
        setIsEditorReady(false);
    };

    // Helper: Trigger party detection
    const runPartyDetection = async (file: File) => {
        setSession(prev => ({
            status: 'detecting_parties',
            progressMessage: 'Scanning document for parties...',
            mode: prev.mode,
            uploadedFile: file,
            uploadedPlaybookFile: prev.uploadedPlaybookFile,
            userParty: prev.userParty,
            detectedParties: prev.detectedParties,
            document: prev.document,
            findings: prev.findings,
            generatedPlaybook: prev.generatedPlaybook,
            activeFindingId: prev.activeFindingId
        }));

        try {
            const doc = await wordAdapter.loadFromFile(file);
            doc.metadata.filename = file.name;

            const parties = await detectPartiesFromDocument(doc);

            setSession(prev => ({
                ...prev,
                status: 'party_selection',
                detectedParties: parties,
                document: doc
            }));
        } catch (e) {
            console.error(e);
            setSession(prev => ({
                ...prev,
                status: 'party_selection',
                detectedParties: ['Provider', 'Customer']
            }));
        }
    };


    // 2. Mode Selection
    const selectMode = async (mode: AppMode) => {
        if (mode === 'edit_playbook') {
            if (session.uploadedFile) {
                setSession(prev => ({ ...prev, mode: mode }));
                await processPlaybookFile(session.uploadedFile, mode);
            } else {
                setSession(prev => ({
                    ...prev,
                    mode: mode,
                    status: 'playbook_selection'
                }));
            }
            return;
        }

        if (session.uploadedFile) {
            setSession(prev => ({ ...prev, mode }));
            await runPartyDetection(session.uploadedFile);
        }
    };

    // HELPER: Process Playbook File
    const processPlaybookFile = async (file: File, activeMode: AppMode) => {
        setSession(prev => ({
            ...prev,
            status: 'processing_playbook',
            progressMessage: 'Parsing uploaded playbook...'
        }));

        try {
            let playbook: Playbook;

            if (file.name.toLowerCase().endsWith('.json')) {
                const text = await file.text();
                playbook = JSON.parse(text);
                playbook = await enrichPlaybookWithEmbeddings(playbook, (msg) => {
                    setSession(prev => ({ ...prev, progressMessage: msg }));
                });

            } else if (file.name.toLowerCase().endsWith('.docx')) {
                const tempDoc = await wordAdapter.loadFromFile(file);
                const fullText = tempDoc.paragraphs.map(p => p.text).join('\n');
                playbook = await parsePlaybookFromText(fullText, file.name, (msg) => {
                    setSession(prev => ({ ...prev, progressMessage: msg }));
                });
            } else {
                throw new Error("Unsupported format");
            }

            if (activeMode === 'edit_playbook') {
                setSession(prev => ({
                    ...prev,
                    status: 'playbook_ready',
                    generatedPlaybook: playbook
                }));
            } else {
                startReview(playbook);
            }

        } catch (error) {
            console.error("Playbook load failed", error);
            alert("Failed to load playbook. Please check format.");
            setSession(prev => ({ ...prev, status: 'playbook_selection' }));
        }
    };

    // 3. Handle Party Selection
    const handlePartySelected = (party: string) => {
        setSession(prev => ({ ...prev, userParty: party }));

        if (session.mode === 'generate_playbook') {
            startPlaybookGeneration(party);
        } else {
            setSession(prev => ({ ...prev, status: 'playbook_selection', userParty: party }));
        }
    };

    // 4a. Playbook Generation Workflow
    const startPlaybookGeneration = async (party: string) => {
        const doc = session.document;
        if (!doc) return;

        setSession(prev => ({
            ...prev,
            status: 'generating_playbook',
            progressMessage: 'Initializing playbook generator...'
        }));

        try {
            const playbook = await generatePlaybookFromDocument(doc, party, (msg) => {
                setSession(prev => ({ ...prev, progressMessage: msg }));
            });
            setSession(prev => ({ ...prev, status: 'playbook_ready', generatedPlaybook: playbook }));
        } catch (e) {
            console.error(e);
            setSession(prev => ({ ...prev, status: 'error', progressMessage: 'Failed to generate playbook.' }));
        }
    };

    // 4b. Review & Edit Workflow - Handle Playbook File Upload
    const handlePlaybookUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.target.files && e.target.files[0]) {
            await processPlaybookFile(e.target.files[0], session.mode!);
        }
    };

    // 5. Final Step: Start Analysis
    const startReview = async (playbook: Playbook) => {
        setSession(prev => ({
            ...prev,
            status: 'scanning',
            progressMessage: 'Structuring document for analysis...'
        }));

        await new Promise(r => setTimeout(r, 100));

        const attemptAnalysis = async (retries = 40) => {
            if (!editorRef.current || !isEditorReady) {
                if (retries > 0) {
                    setTimeout(() => attemptAnalysis(retries - 1), 250);
                    return;
                }
                alert("Editor failed to initialize. Please reload.");
                setSession(prev => ({ ...prev, status: 'error' }));
                return;
            }

            try {
                setSession(prev => ({ ...prev, progressMessage: 'Identifying clauses...' }));
                editorRef.current.structureDocument();

                await new Promise(r => setTimeout(r, 1500));

                const extractedClauses = editorRef.current.getClauses();
                console.log(`Extracted ${extractedClauses.length} clauses from Editor.`);

                if (extractedClauses.length === 0) {
                    console.warn("No clauses extracted. Attempting fallback structure...");
                    editorRef.current.structureDocument();
                    await new Promise(r => setTimeout(r, 1500));
                    const retryClauses = editorRef.current.getClauses();
                    if (retryClauses.length > 0) {
                        extractedClauses.push(...retryClauses);
                    }
                }

                const editorDoc = {
                    metadata: {
                        filename: session.uploadedFile?.name || 'document.docx',
                        timestamp: new Date().toISOString()
                    },
                    paragraphs: extractedClauses.map(c => ({
                        id: c.id,
                        text: c.text,
                        style: 'Normal',
                        outline_level: 0
                    }))
                };

                setSession(prev => ({ ...prev, status: 'analyzing', progressMessage: 'Analyzing contract against playbook...', document: editorDoc }));

                const findings = await analyzeDocumentWithGemini(editorDoc, playbook, session.userParty, (msg) => {
                    setSession(prev => ({ ...prev, progressMessage: msg }));
                });

                setSession(prev => ({
                    ...prev,
                    status: 'review_ready',
                    findings: findings,
                    activeFindingId: null,
                    document: editorDoc
                }));

            } catch (e) {
                console.error(e);
                setSession(prev => ({ ...prev, status: 'error' }));
            }
        };

        attemptAnalysis();
    };

    const handleDebugEditor = () => {
        setSession(prev => ({ ...prev, status: 'editor_debug' }));
    };

    const handleStructureDoc = () => {
        if (editorRef.current) {
            editorRef.current.structureDocument();
            setTimeout(handleInspectClauses, 500);
        }
    };

    const handleInspectClauses = () => {
        if (editorRef.current) {
            const clauses = editorRef.current.getClauses();
            setDebugClauses(clauses);
            console.log("Detected Clauses:", clauses);
        }
    };

    const handleRunAssemblyTests = async () => {
        if (editorRef.current) {
            await editorRef.current.runAssemblyTestSuite();
        }
    };

    const handleCardClick = useCallback((finding: AnalysisFinding) => {
        setSession(prev => ({ ...prev, activeFindingId: finding.target_id }));
        setMobileMenuOpen(false); // Close menu on mobile after selection
    }, []);

    const handleAccept = async (id: string, text: string) => {
        const finding = session.findings.find(f => f.target_id === id);
        if (finding && editorRef.current) {
            const success = await editorRef.current.updateClause(id, text, session.userParty);

            if (success) {
                setSession(prev => ({
                    ...prev,
                    findings: prev.findings.map(f =>
                        f.target_id === id ? { ...f, status: 'resolved', suggested_text: text } : f
                    )
                }));
            } else {
                alert("Failed to apply change. The clause may have been deleted or modified externally.");
            }
        }
    };

    const handleReject = (id: string) => {
        setSession(prev => ({
            ...prev,
            findings: prev.findings.filter(f => f.target_id !== id),
            activeFindingId: null
        }));
    };

    const handleRestart = () => {
        setSession({
            status: 'idle',
            mode: null,
            uploadedFile: null,
            uploadedPlaybookFile: null,
            userParty: 'Provider',
            detectedParties: [],
            document: null,
            findings: [],
            generatedPlaybook: null,
            activeFindingId: null,
            progressMessage: ''
        });
        setManualPartyInput("");
        setShowManualInput(false);
        setDebugClauses([]);
        setShowTestRunner(false);
        setIsEditorReady(false);
    };

    const handleSaveAs = () => {
        console.log('💾 Save button clicked!');

        // Use default filename (prompt blocked by iframe sandbox)
        const baseFilename = session.document?.metadata.filename.replace('.docx', '') || 'reviewed_contract';
        const filename = `${baseFilename}_reviewed`;

        console.log('📝 Export filename:', filename);
        console.log('📂 editorRef exists?', !!editorRef.current);

        if (editorRef.current) {
            editorRef.current.exportDocument(filename);
        } else {
            console.error('❌ No editorRef - cannot export!');
        }
    };

    // Render logic for the Editor
    const shouldRenderEditor = () => {
        const activeStates = ['review_ready', 'editor_debug', 'scanning', 'analyzing'];
        return activeStates.includes(session.status);
    };

    const renderContent = () => {
        if (showTestRunner) {
            return (
                <div className="flex-1 p-4 overflow-hidden">
                    <TestSuiteRunner />
                </div>
            );
        }

        const loadingStates = ['detecting_parties', 'processing_playbook', 'generating_playbook', 'scanning', 'analyzing'];
        if (loadingStates.includes(session.status)) {
            return (
                <div className="flex-1 flex flex-col items-center justify-center p-8 text-center animate-in fade-in duration-300 relative z-50 bg-white min-h-full w-full">
                    <div className="bg-white p-8 rounded-2xl shadow-xl border border-gray-100 max-w-md w-full">
                        <div className="w-16 h-16 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                            <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
                        </div>
                        <h2 className="text-xl font-bold text-gray-800 mb-2">Processing Document</h2>
                        <p className="text-gray-500 mb-6">{session.progressMessage}</p>
                        <div className="w-full bg-gray-100 rounded-full h-2 overflow-hidden">
                            <div className="bg-blue-600 h-full rounded-full w-1/2 animate-pulse"></div>
                        </div>
                    </div>
                </div>
            );
        }

        if (session.status === 'idle' || session.status === 'mode_selection') {
            return (
                <div className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 bg-gray-50 min-h-full w-full">
                    <div className="text-center mb-10 mt-10 md:mt-0">
                        <div className="flex items-center justify-center gap-3 mb-4">
                            <div className="w-12 h-12 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg">
                                <FileText className="w-7 h-7 text-white" />
                            </div>
                            <h1 className="text-4xl font-extrabold text-gray-900 tracking-tight">Contract AI</h1>
                        </div>
                        <p className="text-lg text-gray-600 max-w-lg mx-auto">
                            Advanced contract review and playbook generation powered by Generative AI.
                        </p>
                    </div>

                    {session.status === 'idle' ? (
                        <div className="w-full max-w-xl">
                            <FileUpload onFileSelected={handleFileSelected} />
                            <div className="mt-8 flex justify-center gap-4">
                                <button
                                    onClick={handleDebugEditor}
                                    className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                                >
                                    <Layout className="w-3 h-3" /> Editor Debug
                                </button>
                                <button
                                    onClick={() => setShowTestRunner(true)}
                                    className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
                                >
                                    <TestTube className="w-3 h-3" /> System Tests
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 w-full max-w-4xl animate-in slide-in-from-bottom-4 duration-500 pb-10">
                            {/* Option 1: Generate Playbook */}
                            <div
                                onClick={() => selectMode('generate_playbook')}
                                className="bg-white p-8 rounded-2xl shadow-sm border border-gray-200 hover:shadow-xl hover:border-blue-300 transition-all cursor-pointer group relative overflow-hidden"
                            >
                                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                    <Wand2 className="w-24 h-24 text-blue-600" />
                                </div>
                                <div className="w-12 h-12 bg-blue-50 rounded-lg flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                                    <ScanEye className="w-6 h-6 text-blue-600" />
                                </div>
                                <h3 className="text-xl font-bold text-gray-900 mb-2">Generate Playbook</h3>
                                <p className="text-gray-500 text-sm leading-relaxed">
                                    AI analyzes your document to extract negotiation rules, risk positions, and clauses automatically.
                                </p>
                                <div className="mt-6 flex items-center text-blue-600 font-medium text-sm group-hover:translate-x-1 transition-transform">
                                    Generate New <ChevronRight className="w-4 h-4 ml-1" />
                                </div>
                            </div>

                            {/* Option 2: Edit Existing Playbook */}
                            <div
                                onClick={() => selectMode('edit_playbook')}
                                className="bg-white p-8 rounded-2xl shadow-sm border border-gray-200 hover:shadow-xl hover:border-purple-300 transition-all cursor-pointer group relative overflow-hidden"
                            >
                                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                    <Edit3 className="w-24 h-24 text-purple-600" />
                                </div>
                                <div className="w-12 h-12 bg-purple-50 rounded-lg flex items-center justify-center mb-6 group-hover:scale-110 transition-transform">
                                    <BookOpen className="w-6 h-6 text-purple-600" />
                                </div>
                                <h3 className="text-xl font-bold text-gray-900 mb-2">Edit Playbook</h3>
                                <p className="text-gray-500 text-sm leading-relaxed">
                                    Refine, customize, or manually create a negotiation playbook from a uploaded file.
                                </p>
                                <div className="mt-6 flex items-center text-purple-600 font-medium text-sm group-hover:translate-x-1 transition-transform">
                                    Open Editor <ChevronRight className="w-4 h-4 ml-1" />
                                </div>
                            </div>

                            {/* Option 3: Standard Review */}
                            <div
                                onClick={() => selectMode('review')}
                                className="col-span-1 md:col-span-2 bg-white p-8 rounded-2xl shadow-sm border border-gray-200 hover:shadow-xl hover:border-green-300 transition-all cursor-pointer group relative overflow-hidden"
                            >
                                <div className="absolute top-0 right-0 p-4 opacity-10 group-hover:opacity-20 transition-opacity">
                                    <CheckCircle2 className="w-32 h-32 text-green-600" />
                                </div>
                                <div className="flex items-start gap-6">
                                    <div className="w-12 h-12 bg-green-50 rounded-lg flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform">
                                        <CheckCircle2 className="w-6 h-6 text-green-600" />
                                    </div>
                                    <div>
                                        <h3 className="text-xl font-bold text-gray-900 mb-2">Start Contract Review</h3>
                                        <p className="text-gray-500 text-sm leading-relaxed max-w-lg">
                                            Analyze a contract against an existing playbook. The AI will flag risks, redline clauses, and suggest improvements based on your rules.
                                        </p>
                                        <div className="mt-6 inline-flex items-center text-green-600 font-medium text-sm group-hover:translate-x-1 transition-transform">
                                            Select Playbook & Review <ChevronRight className="w-4 h-4 ml-1" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            );
        }

        if (session.status === 'party_selection') {
            return (
                <div className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 bg-gray-50 min-h-full w-full">
                    <div className="bg-white p-8 rounded-2xl shadow-xl border border-gray-200 max-w-lg w-full">
                        <h2 className="text-2xl font-bold text-gray-900 mb-2">Who are you acting for?</h2>
                        <p className="text-gray-500 mb-6">Select your role in this negotiation to tailor the analysis.</p>

                        <div className="grid grid-cols-2 gap-3 mb-6">
                            {session.detectedParties.map(p => (
                                <button
                                    key={p}
                                    onClick={() => handlePartySelected(p)}
                                    className="p-4 border border-gray-200 rounded-xl hover:border-blue-500 hover:bg-blue-50 hover:text-blue-700 font-medium transition-all text-left"
                                >
                                    {p}
                                </button>
                            ))}
                            <button
                                onClick={() => setShowManualInput(true)}
                                className="p-4 border border-dashed border-gray-300 rounded-xl hover:border-gray-400 hover:bg-gray-50 text-gray-500 font-medium transition-all text-center flex items-center justify-center gap-2"
                            >
                                <Plus className="w-4 h-4" /> Other
                            </button>
                        </div>

                        {showManualInput && (
                            <div className="animate-in fade-in slide-in-from-top-2">
                                <div className="flex gap-2">
                                    <input
                                        type="text"
                                        className="flex-1 border border-gray-300 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                                        placeholder="Enter party name..."
                                        value={manualPartyInput}
                                        onChange={(e) => setManualPartyInput(e.target.value)}
                                        autoFocus
                                    />
                                    <button
                                        onClick={() => handlePartySelected(manualPartyInput)}
                                        disabled={!manualPartyInput.trim()}
                                        className="bg-blue-600 text-white px-4 py-2 rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50"
                                    >
                                        Confirm
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            );
        }

        if (session.status === 'playbook_selection') {
            return (
                <div className="flex-1 flex flex-col items-center justify-center p-4 md:p-8 bg-gray-50 min-h-full w-full">
                    <div className="bg-white p-8 rounded-2xl shadow-xl border border-gray-200 max-w-lg w-full text-center">
                        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-6">
                            <Upload className="w-8 h-8 text-green-600" />
                        </div>
                        <h2 className="text-2xl font-bold text-gray-900 mb-2">Upload Playbook</h2>
                        <p className="text-gray-500 mb-8">Upload a JSON or DOCX playbook to guide the review.</p>

                        <label className="block w-full p-4 border-2 border-dashed border-gray-300 rounded-xl hover:border-green-500 hover:bg-green-50 cursor-pointer transition-all mb-4 group">
                            <input type="file" className="hidden" accept=".json,.docx" onChange={handlePlaybookUpload} />
                            <div className="text-gray-600 group-hover:text-green-700 font-medium">Click to Browse Files</div>
                            <div className="text-xs text-gray-400 mt-1">Supports .json, .docx</div>
                        </label>

                        <button onClick={handleRestart} className="text-sm text-gray-400 hover:text-gray-600 underline">
                            Cancel
                        </button>
                    </div>
                </div>
            );
        }

        if (session.status === 'playbook_ready' && session.generatedPlaybook) {
            return (
                <PlaybookEditor
                    playbook={session.generatedPlaybook}
                    mode={session.mode === 'generate_playbook' ? 'generate' : 'edit'}
                    onUpdate={(pb) => setSession(prev => ({ ...prev, generatedPlaybook: pb }))}
                    onRestart={handleRestart}
                    initialSettings={appSettings}
                    onSaveSettings={handleSaveSettings}
                />
            );
        }

        return null;
    };

    return (
        <div className="min-h-screen bg-white text-slate-900 font-sans selection:bg-blue-100 relative overflow-hidden flex flex-col">

            {/* LAYER 1: Full-Screen Editor (Always Mounted if file present) */}
            <div className={`absolute inset-0 z-0 flex flex-col ${shouldRenderEditor() ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                {session.status === 'editor_debug' && (
                    <div className="p-2 bg-gray-800 text-white text-xs flex gap-2 items-center shrink-0 z-20 relative">
                        <span>DEBUG MODE</span>
                        <label className="flex items-center gap-1 bg-gray-700 hover:bg-gray-600 px-2 py-1 rounded cursor-pointer">
                            <span className="truncate max-w-[100px]">{session.uploadedFile?.name || "Load File"}</span>
                            <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && handleFileSelected(e.target.files[0])} />
                        </label>
                        <button onClick={handleStructureDoc} className="px-2 py-1 bg-blue-600 rounded">Structure Doc</button>
                        <button onClick={handleInspectClauses} className="px-2 py-1 bg-green-600 rounded">Log Clauses</button>
                        <button onClick={handleRunAssemblyTests} className="px-2 py-1 bg-purple-600 rounded">Run Assembly Tests</button>
                        <button onClick={handleRestart} className="ml-auto px-2 py-1 bg-red-600 rounded">Exit</button>
                    </div>
                )}

                {session.status !== 'editor_debug' && (
                    <header className="bg-white border-b border-gray-200 p-3 flex justify-between items-center shadow-sm z-20 shrink-0 h-14 relative">
                        <div className="flex items-center gap-3">
                            <div className="w-8 h-8 bg-blue-600 rounded flex items-center justify-center text-white font-bold shadow-sm">AI</div>
                            <h1 className="font-bold text-gray-700 text-lg hidden md:block">Contract Review</h1>
                            <span className="px-2 py-0.5 bg-gray-100 text-gray-500 text-xs rounded border border-gray-200 truncate max-w-[200px]">
                                {session.uploadedFile?.name || 'Document'}
                            </span>
                        </div>

                        {/* Mobile Menu Toggle */}
                        <button onClick={() => setMobileMenuOpen(!mobileMenuOpen)} className="md:hidden p-2 text-gray-600">
                            <Menu className="w-6 h-6" />
                        </button>

                        <div className="hidden md:flex items-center gap-2">
                            <button onClick={handleSaveAs} className="p-2 hover:bg-gray-100 rounded text-gray-600 flex items-center gap-1 text-sm font-medium">
                                <Download className="w-4 h-4" /> Save
                            </button>
                            <div className="w-px h-6 bg-gray-300 mx-1"></div>
                            <button onClick={handleRestart} className="p-2 hover:bg-gray-100 rounded text-gray-600 flex items-center gap-1 text-sm font-medium">
                                <RotateCcw className="w-4 h-4" /> Reset
                            </button>
                        </div>
                    </header>
                )}

                <div className="flex-1 flex overflow-hidden relative">
                    {/* Left Sidebar (Findings) - Mobile Responsive */}
                    {session.status !== 'editor_debug' && (
                        <div className={`
                        w-80 border-r border-gray-200 bg-gray-50 flex flex-col shrink-0 z-30 shadow-inner
                        fixed inset-y-0 left-0 transform transition-transform duration-300 md:relative md:translate-x-0
                        ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'}
                    `}>
                            <div className="p-3 border-b border-gray-200 bg-white sticky top-0 z-10 flex justify-between items-center">
                                <div>
                                    <h2 className="text-xs font-bold text-gray-500 uppercase tracking-wider mb-1">Risk Analysis</h2>
                                    <div className="flex items-baseline gap-2">
                                        <span className="text-xl font-extrabold text-gray-800">{session.findings.length} Issues</span>
                                        <span className="text-xs font-medium text-red-500 bg-red-50 px-2 py-0.5 rounded-full">
                                            {session.findings.filter(f => f.risk_level === 'red').length} Critical
                                        </span>
                                    </div>
                                </div>
                                {/* Mobile Close */}
                                <button onClick={() => setMobileMenuOpen(false)} className="md:hidden p-1 text-gray-400 hover:text-gray-600">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                            <div className="overflow-y-auto p-3 flex-1 space-y-3">
                                {session.findings.map(finding => (
                                    <RiskCard
                                        key={finding.target_id}
                                        finding={finding}
                                        isSelected={session.activeFindingId === finding.target_id}
                                        onClick={() => handleCardClick(finding)}
                                    />
                                ))}
                                {session.findings.length === 0 && (
                                    <div className="text-center p-4 text-gray-400 text-sm">
                                        No issues found or document compliant.
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Editor Container */}
                    <div className="flex-1 relative bg-gray-100 overflow-hidden flex flex-col">
                        <SuperdocEditor
                            ref={editorRef}
                            file={session.uploadedFile}
                            activeFindingId={session.activeFindingId}
                            user={editorUser}
                            onEditorReady={() => setIsEditorReady(true)}
                            onClearSelection={() => setSession(prev => ({ ...prev, activeFindingId: null }))}
                        />
                    </div>

                    {/* Right Sidebar (Detail) - Mobile Overlay */}
                    {session.status !== 'editor_debug' && session.activeFindingId && (
                        <div className="w-full md:w-[400px] shrink-0 border-l border-gray-200 shadow-xl z-40 bg-white absolute md:relative inset-y-0 right-0 flex flex-col animate-in slide-in-from-right duration-200">
                            <div className="md:hidden p-2 bg-gray-50 border-b flex justify-start">
                                <button onClick={() => setSession(prev => ({ ...prev, activeFindingId: null }))} className="flex items-center gap-1 text-sm text-gray-600">
                                    <ChevronRight className="w-4 h-4 rotate-180" /> Back to Editor
                                </button>
                            </div>
                            <DetailView
                                finding={session.findings.find(f => f.target_id === session.activeFindingId)!}
                                onAccept={handleAccept}
                                onReject={handleReject}
                            />
                        </div>
                    )}
                </div>

                {/* Debug Bottom Panel */}
                {session.status === 'editor_debug' && (
                    <div className="h-32 bg-gray-900 text-green-400 p-2 overflow-auto text-[10px] font-mono border-t border-gray-700 shrink-0 z-20 relative">
                        {debugClauses.length > 0 ? (
                            <pre>{JSON.stringify(debugClauses, null, 2)}</pre>
                        ) : (
                            <div className="opacity-50">Click 'Log Clauses' to inspect document structure...</div>
                        )}
                    </div>
                )}
            </div>

            {/* LAYER 2: Overlay UI (Menus, Loaders, Modals) */}
            {session.status !== 'review_ready' && session.status !== 'editor_debug' && (
                <div className="absolute inset-0 z-40 bg-white overflow-y-auto touch-pan-y flex flex-col">
                    {renderContent()}
                </div>
            )}

            <SettingsModal
                isOpen={isSettingsOpen}
                onClose={() => setIsSettingsOpen(false)}
                onSave={handleSaveSettings}
                initialSettings={appSettings}
            />

            {!showTestRunner && (
                <div className="fixed bottom-2 right-2 opacity-0 hover:opacity-100 transition-opacity z-50">
                    <button onClick={() => setShowTestRunner(true)} className="p-2 bg-gray-800 text-white rounded-full">
                        <Bug className="w-4 h-4" />
                    </button>
                </div>
            )}

            {showTestRunner && (
                <div className="fixed inset-0 z-[100] bg-white">
                    <div className="h-full flex flex-col">
                        <div className="bg-gray-900 text-white p-2 flex justify-between items-center">
                            <h3 className="font-bold">System Test Suite</h3>
                            <button onClick={() => setShowTestRunner(false)} className="text-gray-400 hover:text-white"><RotateCcw className="w-4 h-4" /></button>
                        </div>
                        <div className="flex-1 overflow-hidden">
                            <TestSuiteRunner />
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}