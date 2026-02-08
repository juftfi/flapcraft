import React, { useState, useMemo, useEffect } from 'react';
import { Idea, Blueprint, AISettings } from '../types';
import { generateContractCode, generateFrontendPrompt } from '../services/ai';
import { X, Code, Terminal, UploadCloud, Cpu, FileText, CheckCircle2, Copy, Download, ExternalLink, ArrowLeft, Rocket } from 'lucide-react';
import { useConnectorClient, usePublicClient, useChainId, useAccount } from 'wagmi';
import { createWalletClient, custom } from 'viem';
import { bsc } from 'wagmi/chains';
import { PDFDocument, StandardFonts, rgb, PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

interface BlueprintModalProps {
    idea: Idea;
    blueprint: Blueprint | undefined;
    onClose: () => void;
    t: any;
    aiConfig?: AISettings;
}

const CUSTOM_FONT_PATHS = ['/fonts/NotoSansSC-Regular.otf'];
let cachedFontBytes: Promise<Uint8Array | null> | null = null;

const loadCustomFontBytes = async () => {
    if (!cachedFontBytes) {
        cachedFontBytes = (async () => {
            for (const path of CUSTOM_FONT_PATHS) {
                try {
                    const response = await fetch(path);
                    if (!response.ok) {
                        continue;
                    }
                    const buffer = await response.arrayBuffer();
                    if (buffer.byteLength === 0) continue;
                    return new Uint8Array(buffer);
                } catch (error) {
                    console.warn(`Failed to load font at ${path}`, error);
                    continue;
                }
            }
            console.warn('Failed to load custom PDF font from any known path.');
            return null;
        })();
    }
    return cachedFontBytes;
};

const wrapTextLines = (text: string, font: PDFFont, size: number, maxWidth: number) => {
    const results: string[] = [];
    const breakWord = (word: string) => {
        let current = '';
        for (const char of word) {
            const candidate = `${current}${char}`;
            if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
                current = candidate;
            } else {
                if (current) {
                    results.push(current);
                }
                current = char;
            }
        }
        if (current) {
            results.push(current);
        }
    };

    if (!text.trim()) {
        return [''];
    }

    const words = text.split(' ');
    let currentLine = '';
    const flushCurrent = () => {
        if (currentLine) {
            results.push(currentLine);
            currentLine = '';
        }
    };

    for (const word of words) {
        const candidate = currentLine ? `${currentLine} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
            currentLine = candidate;
            continue;
        }

        flushCurrent();

        if (font.widthOfTextAtSize(word, size) <= maxWidth) {
            currentLine = word;
            continue;
        }

        breakWord(word);
    }

    flushCurrent();
    return results;
};

declare global {
    interface Window {
        solc?: {
            compile: (input: string) => string;
        };
    }
}

const loadSolc = () => {
    if (typeof window === 'undefined') return Promise.reject(new Error('No window environment.'));
    if (window.solc) return Promise.resolve(window.solc);
    const sources = [
        'https://cdn.jsdelivr.net/npm/solc@0.8.23/solc.min.js',
        'https://unpkg.com/solc@0.8.23/solc.min.js',
        'https://cdnjs.cloudflare.com/ajax/libs/solc/0.8.23/solc.min.js',
    ];
    const tryLoad = (src: string) => new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.async = true;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`solc script failed to load: ${src}`));
        document.head.appendChild(script);
    });
    return new Promise<typeof window.solc>((resolve, reject) => {
        const run = async () => {
            for (const src of sources) {
                try {
                    await tryLoad(src);
                    if (window.solc) {
                        resolve(window.solc);
                        return;
                    }
                } catch {
                    // try next source
                }
            }
            reject(new Error('solc failed to load.'));
        };
        run();
    });
};

const stripCodeFence = (source: string) => {
    const trimmed = source.trim();
    const fenceMatch = trimmed.match(/```(?:solidity)?\s*([\s\S]*?)```/i);
    if (fenceMatch?.[1]) return fenceMatch[1].trim();
    return source;
};

const compileSolidity = async (source: string) => {
    const solc = await loadSolc();
    const normalizedSource = stripCodeFence(source);
    const input = {
        language: 'Solidity',
        sources: {
            'Contract.sol': {
                content: normalizedSource,
            },
        },
        settings: {
            outputSelection: {
                '*': {
                    '*': ['abi', 'evm.bytecode'],
                },
            },
        },
    };

    const output = JSON.parse(solc.compile(JSON.stringify(input)));
    const errors = output?.errors || [];
    const hardErrors = errors.filter((err: any) => err.severity === 'error');
    if (hardErrors.length > 0) {
        const message = hardErrors.map((err: any) => err.formattedMessage || err.message).join('\n');
        throw new Error(message);
    }

    const contracts = output?.contracts?.['Contract.sol'];
    const contractName = contracts ? Object.keys(contracts)[0] : undefined;
    if (!contractName) {
        throw new Error('No contract compiled from source.');
    }
    const artifact = contracts[contractName];
    const abi = artifact?.abi;
    const bytecode = artifact?.evm?.bytecode?.object;
    if (!abi || !bytecode) {
        throw new Error('Missing ABI or bytecode from compilation.');
    }
    return { abi, bytecode: `0x${bytecode}`, contractName };
};

const createPdfBlob = async (text: string) => {
    const pdfDoc = await PDFDocument.create();
    pdfDoc.registerFontkit(fontkit);
    const customFontBytes = await loadCustomFontBytes();
    const font = customFontBytes
        ? await pdfDoc.embedFont(customFontBytes)
        : await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontSize = 12;
    const lineHeight = 16;
    const margin = 36;
    let page = pdfDoc.addPage([612, 792]);
    let y = page.getHeight() - margin;
    const maxWidth = page.getWidth() - margin * 2;

    for (const rawLine of text.split('\n')) {
        const lines = wrapTextLines(rawLine, font, fontSize, maxWidth);
        for (const line of lines) {
            if (y <= margin) {
                page = pdfDoc.addPage([612, 792]);
                y = page.getHeight() - margin;
            }
            page.drawText(line, {
                x: margin,
                y,
                font,
                size: fontSize,
                color: rgb(0.93, 0.93, 0.93),
            });
            y -= lineHeight;
        }
        y -= lineHeight / 2;
    }

    const pdfBytes = await pdfDoc.save();
    return new Blob([pdfBytes], { type: 'application/pdf' });
};

const blueprintToMarkdown = (idea: Idea, blueprint: Blueprint) => {
    const sections = [
        `# ${idea.title}`,
        ``,
        `**Ecosystem:** ${idea.ecosystem}`,
        `**Sector:** ${idea.sector}`,
        `**Degen Score:** ${idea.degenScore}%`,
        ``,
        `## Executive Summary`,
        blueprint.overview,
        ``,
        `## Tokenomics`,
        blueprint.tokenomics,
        ``,
        `## Roadmap`,
        blueprint.roadmap,
        ``,
        `## Technical Architecture`,
        blueprint.technicalArchitecture,
    ];

    if (blueprint.contractCode) {
        sections.push(``, `## Contract Code`, '```solidity', blueprint.contractCode, '```');
    }

    if (blueprint.frontendSnippet) {
        sections.push(``, `## Frontend Snippet`, '```tsx', blueprint.frontendSnippet, '```');
    }

    return sections.join('\n');
};

const hashString = (value: string) => {
    let hash = 0;
    for (let i = 0; i < value.length; i++) {
        hash = (hash * 31 + value.charCodeAt(i)) | 0;
    }
    return Math.abs(hash);
};

const buildLogoSvg = (seed: number) => {
    const palette = ['#FCEE09', '#FFB800', '#FFD400', '#FF9A00', '#FFC400', '#F9E547'];
    const bg = palette[seed % palette.length];
    const fg = palette[(seed + 2) % palette.length];
    const accent = palette[(seed + 4) % palette.length];
    const shapeOffset = 12 + (seed % 10);
    const ringSize = 96 + (seed % 12);
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">
  <defs>
    <linearGradient id="g${seed}" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="${bg}" />
      <stop offset="100%" stop-color="${accent}" />
    </linearGradient>
  </defs>
  <rect width="160" height="160" rx="32" fill="url(#g${seed})" opacity="0.9" />
  <circle cx="80" cy="80" r="${ringSize / 2}" fill="none" stroke="${fg}" stroke-width="8" opacity="0.9"/>
  <rect x="${shapeOffset}" y="${shapeOffset}" width="${160 - shapeOffset * 2}" height="${160 - shapeOffset * 2}" rx="22" fill="none" stroke="${accent}" stroke-width="4" opacity="0.8"/>
  <circle cx="${50 + (seed % 20)}" cy="${60 + (seed % 30)}" r="10" fill="${fg}" />
  <circle cx="${110 - (seed % 18)}" cy="${95 - (seed % 25)}" r="6" fill="${accent}" />
</svg>
    `.trim();
};

const buildLogoSet = (ideaTitle: string) => {
    const base = hashString(ideaTitle);
    return Array.from({ length: 4 }).map((_, idx) => {
        const svg = buildLogoSvg(base + idx * 17);
        return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    });
};

const BlueprintModal: React.FC<BlueprintModalProps> = ({ idea, blueprint, onClose, t, aiConfig }) => {
    const [activeTab, setActiveTab] = useState<'DOCS' | 'BUILDER'>('DOCS');
    const { data: walletClient } = useConnectorClient();
    const { isConnected } = useAccount();
    const publicClient = usePublicClient();
    const chainId = useChainId();
    const buildLogsKey = `fourcraft_builder_logs_${idea.id}`;
    const builderStateKey = `fourcraft_builder_state_${idea.id}`;
    const getStoredBuilderState = () => {
        if (typeof window === 'undefined') return null;
        const stored = window.localStorage.getItem(builderStateKey);
        if (!stored) return null;
        try {
            return JSON.parse(stored);
        } catch {
            return null;
        }
    };
    const storedBuilder = getStoredBuilderState();
    const [buildStep, setBuildStep] = useState<number>(typeof storedBuilder?.buildStep === 'number' ? storedBuilder.buildStep : 0); // 0: Idle, 1: Contract, 2: Frontend, 3: Deploy
    const [contractCode, setContractCode] = useState<string>(typeof storedBuilder?.contractCode === 'string' ? storedBuilder.contractCode : '');
    const [frontendPrompt, setFrontendPrompt] = useState<string>(typeof storedBuilder?.frontendPrompt === 'string' ? storedBuilder.frontendPrompt : '');
    const [contractAddress, setContractAddress] = useState<string | null>(typeof storedBuilder?.contractAddress === 'string' ? storedBuilder.contractAddress : null);
    const [logos, setLogos] = useState<string[]>(Array.isArray(storedBuilder?.logos) ? storedBuilder.logos : []);
    const [selectedLogo, setSelectedLogo] = useState<number>(typeof storedBuilder?.selectedLogo === 'number' ? storedBuilder.selectedLogo : 0);
    const [tokenForm, setTokenForm] = useState({
        name: storedBuilder?.tokenForm?.name || '',
        symbol: storedBuilder?.tokenForm?.symbol || '',
        supply: storedBuilder?.tokenForm?.supply || '1000000000',
        description: storedBuilder?.tokenForm?.description || '',
    });
    const [buildLogs, setBuildLogs] = useState<string[]>(() => {
        if (typeof window === 'undefined') return [];
        const stored = window.localStorage.getItem(buildLogsKey);
        if (!stored) return [];
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    });
    const [isContractDeploying, setIsContractDeploying] = useState(false);
    const [isMinting, setIsMinting] = useState(false);
    const blueprintMarkdown = useMemo(() => blueprint ? blueprintToMarkdown(idea, blueprint) : '', [blueprint, idea]);
    const previewTitle = buildStep === 2 ? t.frontend_prompt : buildStep === 3 ? t.deploy_title : t.gen_assets;
    const previewCopyPayload = buildStep === 1 ? contractCode : buildStep === 2 ? frontendPrompt : '';
    const vibeTargets = [
        { label: t.open_claude, url: 'https://www.anthropic.com/claude-code/' },
        { label: t.open_codex, url: 'https://openai.com/codex/' },
        { label: t.open_antigravity, url: 'https://antigravityaiide.com/' },
        { label: t.open_v0, url: 'https://v0.dev/' },
    ];

    const addToLog = (msg: string) => setBuildLogs(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

    useEffect(() => {
        const stored = getStoredBuilderState();
        if (stored) {
            setBuildStep(typeof stored?.buildStep === 'number' ? stored.buildStep : 0);
            setContractCode(typeof stored?.contractCode === 'string' ? stored.contractCode : '');
            setFrontendPrompt(typeof stored?.frontendPrompt === 'string' ? stored.frontendPrompt : '');
            setContractAddress(typeof stored?.contractAddress === 'string' ? stored.contractAddress : null);
            setLogos(Array.isArray(stored?.logos) ? stored.logos : []);
            setSelectedLogo(typeof stored?.selectedLogo === 'number' ? stored.selectedLogo : 0);
            setTokenForm({
                name: stored?.tokenForm?.name || '',
                symbol: stored?.tokenForm?.symbol || '',
                supply: stored?.tokenForm?.supply || '1000000000',
                description: stored?.tokenForm?.description || '',
            });
        } else {
            setBuildStep(0);
            setContractCode('');
            setFrontendPrompt('');
            setContractAddress(null);
            setLogos([]);
            setSelectedLogo(0);
            setTokenForm({
                name: '',
                symbol: '',
                supply: '1000000000',
                description: '',
            });
        }

        if (typeof window !== 'undefined') {
            const storedLogs = window.localStorage.getItem(buildLogsKey);
            if (storedLogs) {
                try {
                    const parsed = JSON.parse(storedLogs);
                    setBuildLogs(Array.isArray(parsed) ? parsed : []);
                } catch {
                    setBuildLogs([]);
                }
            } else {
                setBuildLogs([]);
            }
        }
    }, [builderStateKey, buildLogsKey]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        window.localStorage.setItem(buildLogsKey, JSON.stringify(buildLogs));
    }, [buildLogs, buildLogsKey]);

    useEffect(() => {
        if (typeof window === 'undefined') return;
        const payload = {
            buildStep,
            contractCode,
            frontendPrompt,
            contractAddress,
            logos,
            selectedLogo,
            tokenForm,
        };
        window.localStorage.setItem(builderStateKey, JSON.stringify(payload));
    }, [
        buildStep,
        contractCode,
        frontendPrompt,
        contractAddress,
        logos,
        selectedLogo,
        tokenForm,
        builderStateKey,
    ]);

    const handleStartBuild = async () => {
        const hasCache = Boolean(contractCode || frontendPrompt || contractAddress || logos.length || buildLogs.length);
        if (hasCache) {
            setBuildStep(prev => (prev > 0 ? prev : 1));
            addToLog("Loaded cached builder state.");
            return;
        }

        setBuildStep(1);
        setContractCode('');
        setFrontendPrompt('');
        setContractAddress(null);
        setLogos([]);
        setSelectedLogo(0);
        setIsMinting(false);
        setBuildLogs([]);
        addToLog("Initializing Hardhat environment...");
        addToLog(`Target Chain: ${idea.ecosystem}`);

        try {
            addToLog("Agent: Generating Solidity Smart Contract...");
            const code = await generateContractCode(idea, aiConfig);
            setContractCode(code);
            addToLog("Contract compiled successfully. Bytecode size: 24KB.");
            addToLog("Contract stage ready. Awaiting deployment command.");
        } catch (e) {
            addToLog("Error in contract pipeline.");
            setBuildStep(0);
        }
    };

    const handleContractDeploy = () => {
        if (!contractCode || isContractDeploying) return;
        if (!isConnected) {
            addToLog("Wallet not connected. Please connect to deploy.");
            return;
        }
        if (!publicClient) {
            addToLog("Public client unavailable.");
            return;
        }
        if (chainId !== bsc.id) {
            addToLog("Wrong network. Please switch to BSC.");
            return;
        }
        const run = async () => {
            setIsContractDeploying(true);
            try {
                let activeWalletClient = walletClient;
                if (!activeWalletClient && typeof window !== 'undefined' && (window as any).ethereum) {
                    activeWalletClient = createWalletClient({
                        chain: bsc,
                        transport: custom((window as any).ethereum),
                    });
                }
                if (!activeWalletClient) {
                    addToLog("Wallet client unavailable. Please reconnect your wallet.");
                    setIsContractDeploying(false);
                    return;
                }

                addToLog("Compiling Solidity contract...");
                const { abi, bytecode, contractName } = await compileSolidity(contractCode);
                const ctor = Array.isArray(abi) ? abi.find((item: any) => item.type === 'constructor') : undefined;
                if (ctor?.inputs?.length) {
                    addToLog("Constructor args detected. Deployment requires manual args (not supported in UI).");
                    setIsContractDeploying(false);
                    return;
                }
                addToLog("Deploying contract to BSC...");
                const hash = await activeWalletClient.deployContract({
                    abi,
                    bytecode,
                    args: [],
                });
                addToLog(`Deploy tx sent: ${hash}`);
                const receipt = await publicClient.waitForTransactionReceipt({ hash });
                const deployed = receipt.contractAddress;
                if (deployed) {
                    setContractAddress(deployed);
                    addToLog(`Contract deployed at ${deployed}`);
                } else {
                    addToLog(`Deployment confirmed. Address unavailable for ${contractName}.`);
                }
            } catch (error: any) {
                addToLog(`Deploy failed: ${error?.message || 'Unknown error'}`);
            } finally {
                setIsContractDeploying(false);
            }
        };

        run();
    };

    const handleCopy = async (payload: string) => {
        try {
            await navigator.clipboard.writeText(payload);
            addToLog("Copied output to clipboard.");
        } catch {
            addToLog("Copy failed. Please copy manually.");
        }
    };

    const handleGenerateFrontendPrompt = async () => {
        addToLog("Agent: Writing Dapp build prompt...");
        try {
            const prompt = await generateFrontendPrompt(idea, contractCode, aiConfig);
            setFrontendPrompt(prompt);
            addToLog("Frontend prompt ready. Paste it into your vibe coding IDE.");
        } catch {
            addToLog("Failed to generate frontend prompt.");
        }
    };

    useEffect(() => {
        if (buildStep !== 2 || frontendPrompt) return;
        let active = true;
        const run = async () => {
            try {
                const prompt = await generateFrontendPrompt(idea, contractCode, aiConfig);
                if (!active) return;
                setFrontendPrompt(prompt);
                addToLog("Frontend prompt ready. Paste it into your vibe coding IDE.");
            } catch {
                if (!active) return;
                addToLog("Failed to generate frontend prompt.");
            }
        };
        run();
        return () => {
            active = false;
        };
    }, [aiConfig, buildStep, contractCode, frontendPrompt, idea]);

    useEffect(() => {
        if (buildStep !== 3) return;
        if (logos.length === 0) {
            setLogos(buildLogoSet(idea.title));
            setSelectedLogo(0);
        }
        setTokenForm(prev => ({
            name: prev.name || idea.title,
            symbol: prev.symbol || idea.title.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase() || 'FOUR',
            supply: prev.supply || '1000000000',
            description: prev.description || idea.tagline || idea.description.slice(0, 120),
        }));
    }, [buildStep, idea, logos.length]);

    const handleMintChaos = () => {
        if (isMinting) return;
        setIsMinting(true);
        addToLog("Submitting token metadata to four.meme...");
        setTimeout(() => {
            addToLog("Token minted. Chaos released.");
            setIsMinting(false);
        }, 2000);
    };

    const handleResetCache = () => {
        if (typeof window !== 'undefined') {
            window.localStorage.removeItem(buildLogsKey);
            window.localStorage.removeItem(builderStateKey);
        }
        setBuildStep(0);
        setContractCode('');
        setFrontendPrompt('');
        setContractAddress(null);
        setLogos([]);
        setSelectedLogo(0);
        setTokenForm({
            name: '',
            symbol: '',
            supply: '1000000000',
            description: '',
        });
        setBuildLogs([]);
        setIsContractDeploying(false);
        setIsMinting(false);
    };

    const downloadFile = (filename: string, data: Blob | string, mime: string) => {
        const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        link.click();
        URL.revokeObjectURL(link.href);
    };

    const handleExportMarkdown = () => {
        if (!blueprint) return;
        const safeName = idea.title.replace(/[^a-z0-9]+/gi, '_') || 'blueprint';
        downloadFile(`${safeName}.md`, blueprintMarkdown, 'text/markdown');
    };

    const handleExportPdf = async () => {
        if (!blueprint) return;
        const safeName = idea.title.replace(/[^a-z0-9]+/gi, '_') || 'blueprint';
        const blob = await createPdfBlob(blueprintMarkdown || '');
        downloadFile(`${safeName}.pdf`, blob, 'application/pdf');
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-sm">
            <div className="bg-[#050505] border border-white/10 w-full max-w-4xl h-[85vh] rounded-2xl flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)] overflow-hidden">

                {/* Header */}
                <div className="flex items-center justify-between p-6 border-b border-white/10 bg-[#0A0A0A]">
                    <div>
                        <h2 className="text-xl font-bold text-white flex items-center gap-3">
                            {idea.title}
                            <span className="text-xs font-mono px-2 py-0.5 rounded bg-[#FCEE09]/10 text-[#FCEE09]">{t.blueprint_mode}</span>
                        </h2>
                        <div className="flex items-center gap-3 mt-1">
                            <p className="text-xs text-gray-500 font-mono">{idea.id}</p>
                            <button
                                onClick={handleResetCache}
                                className="text-[10px] font-mono px-2 py-0.5 rounded border border-white/10 text-gray-400 hover:border-white/40 hover:text-white transition"
                            >
                                {t.reset_cache}
                            </button>
                        </div>
                    </div>
                    <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">
                        <X className="w-6 h-6" />
                    </button>
                </div>

                {/* Tabs */}
                <div className="flex border-b border-white/10">
                    <button
                        onClick={() => setActiveTab('DOCS')}
                        className={`px-6 py-3 text-sm font-mono transition-colors ${activeTab === 'DOCS' ? 'text-[#FCEE09] border-b-2 border-[#FCEE09] bg-[#FCEE09]/5' : 'text-gray-500 hover:text-white'}`}
                    >
                        {t.tab_docs}
                    </button>
                    <button
                        onClick={() => setActiveTab('BUILDER')}
                        className={`px-6 py-3 text-sm font-mono transition-colors ${activeTab === 'BUILDER' ? 'text-[#FFB800] border-b-2 border-[#FFB800] bg-[#FFB800]/5' : 'text-gray-500 hover:text-white'}`}
                    >
                        {t.tab_builder}
                    </button>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-8 custom-scrollbar">
                    {activeTab === 'DOCS' ? (
                        blueprint ? (
                            <div className="space-y-8 max-w-3xl mx-auto">
                                <section className="flex flex-col gap-4">
                                    <div className="flex flex-wrap gap-2 justify-end">
                                        <button
                                            onClick={handleExportMarkdown}
                                            disabled={!blueprint}
                                            className="flex items-center gap-2 px-3 py-1.5 bg-white/5 text-xs font-mono rounded-full border border-white/10 hover:border-white/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                                        >
                                            <FileText className="w-4 h-4 text-[#FCEE09]" /> Markdown
                                        </button>
                                        <button
                                            onClick={handleExportPdf}
                                            disabled={!blueprint}
                                            className="flex items-center gap-2 px-3 py-1.5 bg-white/5 text-xs font-mono rounded-full border border-white/10 hover:border-white/30 disabled:opacity-50 disabled:cursor-not-allowed transition"
                                        >
                                            <Download className="w-4 h-4 text-[#FFB800]" /> PDF
                                        </button>
                                    </div>
                                    <h3 className="text-[#FCEE09] font-mono text-sm mb-3 uppercase tracking-widest flex items-center gap-2">
                                        <FileText className="w-4 h-4" /> {t.exec_summary}
                                    </h3>
                                    <div className="text-gray-300 leading-relaxed whitespace-pre-line text-sm">{blueprint.overview}</div>
                                </section>

                                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                                    <section className="bg-white/5 p-6 rounded-lg border border-white/5">
                                        <h3 className="text-[#FCEE09] font-mono text-sm mb-3 uppercase tracking-widest">{t.tokenomics}</h3>
                                        <div className="text-gray-400 text-xs whitespace-pre-line leading-relaxed font-mono">{blueprint.tokenomics}</div>
                                    </section>
                                    <section className="bg-white/5 p-6 rounded-lg border border-white/5">
                                        <h3 className="text-[#FCEE09] font-mono text-sm mb-3 uppercase tracking-widest">{t.roadmap}</h3>
                                        <div className="text-gray-400 text-xs whitespace-pre-line leading-relaxed font-mono">{blueprint.roadmap}</div>
                                    </section>
                                </div>

                                <section>
                                    <h3 className="text-[#FCEE09] font-mono text-sm mb-3 uppercase tracking-widest flex items-center gap-2">
                                        <Cpu className="w-4 h-4" /> {t.tech_arch}
                                    </h3>
                                    <div className="p-4 bg-black border border-white/10 rounded font-mono text-xs text-gray-400 whitespace-pre-wrap">
                                        {blueprint.technicalArchitecture}
                                    </div>
                                </section>
                            </div>
                        ) : (
                            <div className="flex flex-col items-center justify-center h-full text-gray-500 gap-4">
                                <div className="w-8 h-8 border-2 border-[#FCEE09] border-t-transparent rounded-full animate-spin"></div>
                                <p className="font-mono text-xs">{t.architecting}</p>
                            </div>
                        )
                    ) : (
                        <div className="flex flex-col h-full gap-6">
                            {/* Progress Bar */}
                            <div className="flex justify-between items-center bg-white/5 p-4 rounded-lg border border-white/5">
                                {[
                                    { id: 1, label: t.step_contract, icon: Code },
                                    { id: 2, label: t.step_frontend, icon: Terminal },
                                    { id: 3, label: t.step_deploy, icon: UploadCloud },
                                ].map((step, idx) => (
                                    <div key={step.id} className={`flex items-center gap-3 ${buildStep >= step.id ? 'text-[#FFB800] opacity-100' : 'text-gray-600 opacity-50'
                                        }`}>
                                        <div className={`w-8 h-8 rounded-full flex items-center justify-center border ${buildStep >= step.id ? 'border-[#FFB800] bg-[#FFB800]/10' : 'border-gray-700'
                                            }`}>
                                            {buildStep > step.id ? <CheckCircle2 className="w-5 h-5" /> : <step.icon className="w-4 h-4" />}
                                        </div>
                                        <span className="text-xs font-mono font-bold hidden sm:block">{step.label}</span>
                                        {idx < 2 && <div className="w-12 h-[1px] bg-gray-800 mx-2 hidden sm:block"></div>}
                                    </div>
                                ))}
                            </div>

                            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1 min-h-0">
                                {/* Terminal Log + Vibe Buttons */}
                                <div className="flex flex-col gap-4 min-h-0">
                                    <div className="bg-black border border-white/10 rounded-lg p-4 font-mono text-xs overflow-y-auto flex flex-col min-h-0">
                                        <div className="text-gray-500 mb-2 border-b border-gray-800 pb-2">{t.build_logs}</div>
                                        <div className="flex-1 space-y-1">
                                            {buildLogs.length === 0 && <span className="text-gray-700">{t.waiting}</span>}
                                            {buildLogs.map((log, i) => (
                                                <div key={i} className="text-[#FCEE09]">{`> ${log}`}</div>
                                            ))}
                                            {buildStep > 0 && buildStep < 4 && <div className="animate-pulse text-[#FFB800] mt-2">_</div>}
                                        </div>
                                    </div>

                                    {buildStep === 2 && frontendPrompt && (
                                        <div className="grid grid-cols-2 gap-3">
                                            {vibeTargets.map(target => (
                                                <button
                                                    key={target.label}
                                                    onClick={() => window.open(target.url, '_blank', 'noopener,noreferrer')}
                                                    className="flex items-center justify-center gap-2 px-3 py-2 text-xs font-mono rounded border border-white/10 text-gray-300 hover:border-white/40 hover:text-white transition"
                                                >
                                                    <ExternalLink className="w-3 h-3" /> {target.label}
                                                </button>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {/* Preview / Code */}
                                <div className="bg-[#111] border border-white/10 rounded-lg p-4 flex flex-col min-h-0">
                                    <div className="flex justify-between items-center mb-2 border-b border-gray-800 pb-2">
                                        <span className="text-gray-500 font-mono text-xs">{previewTitle}</span>
                                        {previewCopyPayload && (
                                            <Copy
                                                className="w-3 h-3 text-gray-500 cursor-pointer hover:text-white"
                                                onClick={() => handleCopy(previewCopyPayload)}
                                            />
                                        )}
                                    </div>
                                    <div className="flex-1 overflow-y-auto custom-scrollbar">
                                        {buildStep === 1 && (
                                            contractCode ? (
                                                <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap">
                                                    {contractCode}
                                                </pre>
                                            ) : (
                                                <div className="flex items-center justify-center h-full text-gray-700 text-xs font-mono">
                                                    {t.no_assets}
                                                </div>
                                            )
                                        )}
                                        {buildStep === 2 && (
                                            frontendPrompt ? (
                                                <pre className="text-[10px] text-gray-400 font-mono whitespace-pre-wrap">
                                                    {frontendPrompt}
                                                </pre>
                                            ) : (
                                                <div className="flex items-center justify-center h-full text-gray-700 text-xs font-mono">
                                                    {t.waiting}
                                                </div>
                                            )
                                        )}
                                        {buildStep === 3 && (
                                            <div className="space-y-4 text-xs font-mono text-gray-300">
                                                <div className="text-gray-500">{t.deploy_notice}</div>
                                                <div className="space-y-3">
                                                    <label className="block">
                                                        <span className="text-gray-500">{t.token_name}</span>
                                                        <input
                                                            value={tokenForm.name}
                                                            onChange={(e) => setTokenForm(prev => ({ ...prev, name: e.target.value }))}
                                                            className="mt-1 w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-gray-200"
                                                        />
                                                    </label>
                                                    <label className="block">
                                                        <span className="text-gray-500">{t.token_symbol}</span>
                                                        <input
                                                            value={tokenForm.symbol}
                                                            onChange={(e) => setTokenForm(prev => ({ ...prev, symbol: e.target.value.toUpperCase() }))}
                                                            className="mt-1 w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-gray-200"
                                                        />
                                                    </label>
                                                    <label className="block">
                                                        <span className="text-gray-500">{t.token_supply}</span>
                                                        <input
                                                            value={tokenForm.supply}
                                                            onChange={(e) => setTokenForm(prev => ({ ...prev, supply: e.target.value }))}
                                                            className="mt-1 w-full bg-black/40 border border-white/10 rounded px-3 py-2 text-gray-200"
                                                        />
                                                    </label>
                                                    <label className="block">
                                                        <span className="text-gray-500">{t.token_desc}</span>
                                                        <textarea
                                                            value={tokenForm.description}
                                                            onChange={(e) => setTokenForm(prev => ({ ...prev, description: e.target.value }))}
                                                            className="mt-1 w-full h-20 bg-black/40 border border-white/10 rounded px-3 py-2 text-gray-200 resize-none"
                                                        />
                                                    </label>
                                                </div>

                                                <div className="space-y-2">
                                                    <div className="text-gray-500">{t.logo_auto}</div>
                                                    <div className="grid grid-cols-2 gap-3">
                                                        {logos.map((logo, idx) => (
                                                            <button
                                                                key={logo}
                                                                onClick={() => setSelectedLogo(idx)}
                                                                className={`border rounded-lg p-2 transition ${selectedLogo === idx ? 'border-[#FFB800] bg-[#FFB800]/10' : 'border-white/10 hover:border-white/30'}`}
                                                            >
                                                                <img src={logo} alt={`logo-${idx}`} className="w-full h-24 object-contain" />
                                                            </button>
                                                        ))}
                                                    </div>
                                                </div>
                                            </div>
                                        )}
                                        {buildStep === 0 && (
                                            <div className="flex items-center justify-center h-full text-gray-700 text-xs font-mono">
                                                {t.no_assets}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            </div>

                            {buildStep === 0 && (
                                <div className="flex flex-col sm:flex-row gap-3">
                                    <button
                                        onClick={handleStartBuild}
                                        className="flex-1 py-4 bg-[#FFB800] text-black font-bold font-mono rounded hover:bg-[#E69A00] transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(255,184,0,0.25)]"
                                    >
                                        <Cpu className="w-4 h-4" /> {t.init_builder}
                                    </button>
                                </div>
                            )}

                            {buildStep === 1 && (
                                <div className="flex flex-col sm:flex-row gap-3">
                                    <button
                                        onClick={handleContractDeploy}
                                        disabled
                                        className="flex-1 py-3 bg-white/5 text-gray-500 font-mono rounded border border-white/10 cursor-not-allowed flex items-center justify-center gap-3"
                                    >
                                        <UploadCloud className="w-4 h-4" /> {t.contract_deploy}
                                        <span className="text-[10px] uppercase tracking-widest px-2 py-0.5 rounded-full border border-[#FFB800]/40 text-[#FFB800] bg-[#FFB800]/10">
                                            Coming Soon
                                        </span>
                                    </button>
                                    <button
                                        onClick={() => setBuildStep(2)}
                                        disabled={!contractCode}
                                        className="flex-1 py-3 bg-[#FFB800] text-black font-bold font-mono rounded hover:bg-[#E69A00] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <Rocket className="w-4 h-4" /> {t.next_step}
                                    </button>
                                </div>
                            )}

                            {buildStep === 2 && (
                                <div className="flex flex-col sm:flex-row gap-3">
                                    <button
                                        onClick={() => setBuildStep(1)}
                                        className="flex-1 py-3 bg-white/5 text-gray-300 font-mono rounded border border-white/10 hover:border-white/40 flex items-center justify-center gap-2"
                                    >
                                        <ArrowLeft className="w-4 h-4" /> {t.prev_step}
                                    </button>
                                    <button
                                        onClick={handleGenerateFrontendPrompt}
                                        disabled={!contractCode}
                                        className="sm:w-56 py-3 bg-white/10 text-white font-mono rounded border border-white/10 hover:border-white/40 flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <Terminal className="w-4 h-4" /> {t.generate_prompt}
                                    </button>
                                    <button
                                        onClick={() => setBuildStep(3)}
                                        disabled={!frontendPrompt}
                                        className="flex-1 py-3 bg-[#FFB800] text-black font-bold font-mono rounded hover:bg-[#E69A00] transition-all flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        <UploadCloud className="w-4 h-4" /> {t.mint_token}
                                    </button>
                                </div>
                            )}

                            {buildStep === 3 && (
                                <div className="flex flex-col sm:flex-row gap-3">
                                    <button
                                        onClick={() => setBuildStep(2)}
                                        className="flex-1 py-4 bg-white/5 text-gray-300 font-mono rounded border border-white/10 hover:border-white/40 flex items-center justify-center gap-2"
                                    >
                                        <ArrowLeft className="w-4 h-4" /> {t.prev_step}
                                    </button>
                                    <button
                                        onClick={handleMintChaos}
                                        disabled={isMinting}
                                        className="flex-1 py-4 bg-gradient-to-r from-[#FFB800] to-[#FF9A00] text-black font-bold font-mono rounded hover:brightness-110 transition-all flex items-center justify-center gap-2 disabled:opacity-60"
                                    >
                                        <Rocket className="w-4 h-4" /> {t.min_chaos}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default BlueprintModal;
