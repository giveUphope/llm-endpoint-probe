import { Activity, Braces, Database, PanelLeftClose, PanelLeftOpen, Radio, ScrollText, ShieldCheck } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { EndpointPanel } from './components/EndpointPanel';
import { ExportDialog, type ExportFormat, ValidationDialog } from './components/Dialogs';
import { ModelDetail } from './components/ModelDetail';
import { ModelsTable, type SortKey } from './components/ModelsTable';
import { ProbeLog } from './components/ProbeLog';
import type { CapabilityKey, DiscoveryRun, DiscoveredModel, EndpointProfile, RequestRecord } from './domain/types';
import { downloadText, dshConfig, openAIConfig, universalReport } from './lib/exporters';
import { createProfile, uid } from './lib/profile';
import { discover, validateModel } from './services/discovery';

const STORAGE_KEY = 'llm-endpoint-probe:profiles:v1';

function loadProfiles(): EndpointProfile[] {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(stored) && stored.length ? stored : [createProfile()];
  } catch { return [createProfile()]; }
}

const confidenceOrder = { unknown: 0, low: 1, medium: 2, high: 3 };

export default function App() {
  const [profiles, setProfiles] = useState<EndpointProfile[]>(loadProfiles);
  const [activeId, setActiveId] = useState(profiles[0].id);
  const profile = profiles.find((item) => item.id === activeId) ?? profiles[0];
  const [run, setRun] = useState<DiscoveryRun>();
  const [selectedId, setSelectedId] = useState<string>();
  const [activeView, setActiveView] = useState<'models' | 'logs'>('models');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState('');
  const [confidenceFilter, setConfidenceFilter] = useState('');
  const [protocolFilter, setProtocolFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('displayName');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [validationModel, setValidationModel] = useState<DiscoveredModel>();
  const [exportOpen, setExportOpen] = useState(false);
  const [toast, setToast] = useState('');
  const controllerRef = useRef<AbortController | undefined>(undefined);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2800); };
  const updateProfile = (next: EndpointProfile) => setProfiles((items) => items.map((item) => item.id === next.id ? next : item));
  const saveProfiles = () => { localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles)); notify('端点配置已保存到本机浏览器'); };
  const createNew = () => { const next = createProfile(); setProfiles((items) => [...items, next]); setActiveId(next.id); setRun(undefined); setSelectedId(undefined); };
  const duplicate = () => { const now = new Date().toISOString(); const next = { ...structuredClone(profile), id: uid(), name: `${profile.name} 副本`, createdAt: now, updatedAt: now }; setProfiles((items) => [...items, next]); setActiveId(next.id); };
  const remove = () => { const remaining = profiles.filter((item) => item.id !== profile.id); const next = remaining.length ? remaining : [createProfile()]; setProfiles(next); setActiveId(next[0].id); localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); setRun(undefined); setSelectedId(undefined); };

  const startProbe = async () => {
    if (!profile.baseURL.trim()) { notify('请先填写 baseURL'); return; }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setSelectedId(undefined);
    setActiveView('logs');
    const result = await discover(profile, controller.signal, setRun);
    if (result.models.length) { setSelectedId(result.models[0].id); setActiveView('models'); }
    notify(result.status === 'success' ? `探测完成：发现 ${result.models.length} 个模型` : result.status === 'cancelled' ? '探测已取消' : '探测未完成，请查看错误详情');
  };

  const importProfile = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text());
      const source = parsed.endpoint ?? parsed;
      if (!source.baseURL || !source.name) throw new Error('缺少 name 或 baseURL');
      const base = createProfile();
      const next: EndpointProfile = { ...base, ...source, id: uid(), headers: Array.isArray(source.headers) ? source.headers.map((item: { key?: string; value?: string }) => ({ id: uid(), key: item.key || '', value: item.value || '' })) : [], queryParams: Array.isArray(source.queryParams) ? source.queryParams.map((item: { key?: string; value?: string }) => ({ id: uid(), key: item.key || '', value: item.value || '' })) : [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      setProfiles((items) => [...items, next]); setActiveId(next.id); notify('配置已导入，请检查后保存');
    } catch (error) { notify(`导入失败：${error instanceof Error ? error.message : '文件无效'}`); }
  };

  const performExport = (format: ExportFormat, includeSecret: boolean, includeInferred: boolean) => {
    const options = { includeSecret, includeInferred };
    const models = run?.models ?? [];
    const content = format === 'report' ? universalReport(profile, run, options) : format === 'openai' ? openAIConfig(profile, models, options) : dshConfig(profile, models, options);
    downloadText(`llm-probe-${profile.name.replace(/\s+/g, '-')}.${format === 'dsh' ? 'yaml' : 'json'}`, content, format === 'dsh' ? 'text/yaml' : 'application/json');
    setExportOpen(false); notify(includeSecret ? '已导出（包含明文密钥）' : '已安全导出（不含密钥）');
  };

  const runValidation = async (items: CapabilityKey[]) => {
    if (!validationModel || !run) return;
    const target = validationModel;
    setValidationModel(undefined);
    setRun((current) => current ? { ...current, models: current.models.map((item) => item.id === target.id ? { ...item, status: 'validating' } : item) } : current);
    const controller = new AbortController();
    controllerRef.current = controller;
    const result = await validateModel(profile, target, items, controller.signal, (request: RequestRecord) => setRun((current) => {
      if (!current) return current;
      const requests = current.requests.some((item) => item.id === request.id) ? current.requests.map((item) => item.id === request.id ? request : item) : [...current.requests, request];
      return { ...current, requests };
    })).catch((error: Error) => { notify(`验证失败：${error.message}`); return null; });
    if (result) { setRun((current) => current ? { ...current, models: current.models.map((item) => item.id === result.id ? result : item) } : current); notify(result.status === 'partial' ? '验证已取消，已保留完成的证据' : '模型能力验证完成'); }
  };

  const filteredModels = useMemo(() => {
    const models = run?.models ?? [];
    const query = search.trim().toLowerCase();
    return models.filter((model) => (!query || model.id.toLowerCase().includes(query) || model.displayName.toLowerCase().includes(query)) && (!confidenceFilter || model.confidence === confidenceFilter) && (!protocolFilter || model.protocol === protocolFilter) && (!statusFilter || model.status === statusFilter) && (!capabilityFilter || (capabilityFilter === 'vision' ? model.inputModalities.includes('image') : model.capabilities[capabilityFilter as CapabilityKey]?.value === 'supported'))).sort((a, b) => {
      let comparison = 0;
      if (sortKey === 'displayName') comparison = a.displayName.localeCompare(b.displayName);
      else if (sortKey === 'confidence') comparison = confidenceOrder[a.confidence] - confidenceOrder[b.confidence];
      else if (sortKey === 'lastProbedAt') comparison = a.lastProbedAt.localeCompare(b.lastProbedAt);
      else comparison = (a[sortKey] ?? -1) - (b[sortKey] ?? -1);
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [run?.models, search, capabilityFilter, confidenceFilter, protocolFilter, statusFilter, sortKey, sortDirection]);
  const selectedModel = run?.models.find((item) => item.id === selectedId);
  const handleSort = (key: SortKey) => { if (key === sortKey) setSortDirection((value) => value === 'asc' ? 'desc' : 'asc'); else { setSortKey(key); setSortDirection('asc'); } };

  return <div className="app-shell">
    <header className="app-header"><div className="brand"><div className="brand-mark"><Radio size={18} /></div><div><h1>LLM API 端点探测器</h1><span>Endpoint Probe Workbench</span></div></div><div className="header-status"><span><ShieldCheck size={14} />本地受控代理</span><span><Database size={14} />响应上限 4 MiB</span></div></header>
    <div className={`workspace ${sidebarOpen ? '' : 'sidebar-collapsed'} ${selectedModel ? 'detail-open' : ''}`}>
      {sidebarOpen && <EndpointPanel profile={profile} profiles={profiles} running={run?.status === 'running' || Boolean(run?.models.some((model) => model.status === 'validating'))} onChange={updateProfile} onSelect={(id) => { setActiveId(id); setRun(undefined); setSelectedId(undefined); }} onNew={createNew} onSave={saveProfiles} onDuplicate={duplicate} onDelete={remove} onImport={importProfile} onExport={() => setExportOpen(true)} onProbe={startProbe} onCancel={() => controllerRef.current?.abort()} />}
      <main className="main-workspace">
        <div className="workspace-heading"><div className="heading-left"><button className="icon-button" title={sidebarOpen ? '收起配置' : '展开配置'} onClick={() => setSidebarOpen(!sidebarOpen)}>{sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button><div><span className="eyebrow">工作台</span><h2>{profile.name}</h2></div></div><div className="run-state"><span className={`run-dot run-${run?.status || 'idle'}`} />{run ? ({ running: '探测进行中', success: '探测完成', partial: '部分完成', error: '探测失败', cancelled: '已取消', idle: '未开始' }[run.status]) : '等待探测'}</div></div>
        <div className="view-tabs"><button className={activeView === 'models' ? 'active' : ''} onClick={() => setActiveView('models')}><Braces size={15} />模型结果 <span>{run?.models.length ?? 0}</span></button><button className={activeView === 'logs' ? 'active' : ''} onClick={() => setActiveView('logs')}><ScrollText size={15} />探测与请求 <span>{run?.requests.length ?? 0}</span></button></div>
        {activeView === 'models' ? <ModelsTable models={filteredModels} selectedId={selectedId} search={search} capabilityFilter={capabilityFilter} confidenceFilter={confidenceFilter} protocolFilter={protocolFilter} statusFilter={statusFilter} sortKey={sortKey} sortDirection={sortDirection} onSearch={setSearch} onCapabilityFilter={setCapabilityFilter} onConfidenceFilter={setConfidenceFilter} onProtocolFilter={setProtocolFilter} onStatusFilter={setStatusFilter} onSort={handleSort} onSelect={(model) => setSelectedId(model.id)} /> : <ProbeLog run={run} />}
      </main>
      {selectedModel && <ModelDetail model={selectedModel} requests={run?.requests ?? []} onClose={() => setSelectedId(undefined)} canValidate={profile.allowValidation} onValidate={() => setValidationModel(selectedModel)} />}
    </div>
    {validationModel && <ValidationDialog modelName={validationModel.displayName} onClose={() => setValidationModel(undefined)} onStart={runValidation} />}
    {exportOpen && <ExportDialog onClose={() => setExportOpen(false)} onExport={performExport} />}
    {toast && <div className="toast"><Activity size={15} />{toast}</div>}
  </div>;
}
