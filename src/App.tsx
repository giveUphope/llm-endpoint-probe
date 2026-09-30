import { Activity, Braces, Database, LoaderCircle, PanelLeftClose, PanelLeftOpen, Radio, RefreshCw, ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EndpointPanel } from './components/EndpointPanel';
import { ValidationDialog } from './components/Dialogs';
import { ModelDetail } from './components/ModelDetail';
import { ModelsTable, type SortKey } from './components/ModelsTable';
import { ProbeLog } from './components/ProbeLog';
import type { CapabilityKey, DiscoveryRun, DiscoveredModel, EndpointProfile, RequestRecord } from './domain/types';
import { createProfile, uid } from './lib/profile';
import { discover, modelGenerationInterfaces, modelProbeInterfaces, validateModel } from './services/discovery';
import { checkProxyHealth, clearEndpointHistory, listEndpointHistory, restoreEndpointHistory, type EndpointHistoryItem } from './services/proxy';
import { fetchReferenceCatalog, type ReferenceState } from './services/reference';

const confidenceOrder = { unknown: 0, low: 1, medium: 2, high: 3 };

type ProxyHealthState = {
  status: 'checking' | 'online' | 'offline';
  message: string;
  maxResponseBytes?: number;
  lastCheckedAt?: string;
};

function responseLimitLabel(bytes?: number): string {
  if (!bytes) return '响应上限 未确认';
  return `响应上限 ${bytes / (1024 * 1024)} MiB`;
}

export default function App() {
  const [profile, setProfile] = useState<EndpointProfile>(createProfile);
  const [run, setRun] = useState<DiscoveryRun>();
  const [selectedId, setSelectedId] = useState<string>();
  const [activeView, setActiveView] = useState<'models' | 'logs'>('models');
  const compactLayout = useRef(typeof window !== 'undefined' && window.innerWidth <= 900);
  const [compact, setCompact] = useState<boolean>(compactLayout.current);
  const [sidebarOpen, setSidebarOpen] = useState(() => typeof window === 'undefined' || window.innerWidth > 900);
  const [search, setSearch] = useState('');
  const [capabilityFilter, setCapabilityFilter] = useState('');
  const [confidenceFilter, setConfidenceFilter] = useState('');
  const [protocolFilter, setProtocolFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('displayName');
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc');
  const [validationModel, setValidationModel] = useState<DiscoveredModel>();
  const [toast, setToast] = useState('');
  const [endpointHistory, setEndpointHistory] = useState<EndpointHistoryItem[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [proxyHealth, setProxyHealth] = useState<ProxyHealthState>({ status: 'checking', message: '正在验证本地受控代理' });
  const controllerRef = useRef<AbortController | undefined>(undefined);
  const healthCheckSequence = useRef(0);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const previousSidebarOpen = useRef(sidebarOpen);
  const referenceRequested = useRef(false);
  const [reference, setReference] = useState<ReferenceState>({ status: 'loading' });

  // OpenRouter 参照目录：只读拉取一次用于模型信息比对，失败时降级展示且不影响探测
  const loadReference = useCallback(async () => {
    setReference({ status: 'loading' });
    try {
      setReference({ status: 'ready', catalog: await fetchReferenceCatalog() });
    } catch (error) {
      setReference({ status: 'error', message: error instanceof Error ? error.message : '参照目录获取失败' });
    }
  }, []);

  const refreshProxyHealth = useCallback(async (showChecking = true): Promise<boolean> => {
    const sequence = ++healthCheckSequence.current;
    if (showChecking) setProxyHealth((current) => ({ ...current, status: 'checking', message: '正在验证本地受控代理' }));
    try {
      const health = await checkProxyHealth();
      if (healthCheckSequence.current === sequence) {
        setProxyHealth({ status: 'online', message: `守卫 v${health.guardVersion} 已验证`, maxResponseBytes: health.maxResponseBytes, lastCheckedAt: new Date().toISOString() });
      }
      return true;
    } catch (error) {
      if (healthCheckSequence.current === sequence) {
        setProxyHealth({ status: 'offline', message: error instanceof Error ? error.message : '本地受控代理不可用', lastCheckedAt: new Date().toISOString() });
      }
      return false;
    }
  }, []);

  const refreshEndpointHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      setEndpointHistory(await listEndpointHistory());
    } catch {
      setEndpointHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshProxyHealth();
    const interval = window.setInterval(() => void refreshProxyHealth(false), 15000);
    const recheck = () => void refreshProxyHealth(false);
    const recheckWhenVisible = () => { if (document.visibilityState === 'visible') recheck(); };
    window.addEventListener('focus', recheck);
    window.addEventListener('online', recheck);
    document.addEventListener('visibilitychange', recheckWhenVisible);
    return () => {
      healthCheckSequence.current += 1;
      window.clearInterval(interval);
      window.removeEventListener('focus', recheck);
      window.removeEventListener('online', recheck);
      document.removeEventListener('visibilitychange', recheckWhenVisible);
    };
  }, [refreshProxyHealth]);

  useEffect(() => {
    if (proxyHealth.status === 'online') void refreshEndpointHistory();
    if (proxyHealth.status === 'offline') {
      setEndpointHistory([]);
      setHistoryLoading(false);
    }
  }, [proxyHealth.status, refreshEndpointHistory]);

  useEffect(() => {
    if (proxyHealth.status === 'online' && !referenceRequested.current) {
      referenceRequested.current = true;
      void loadReference();
    }
    if (proxyHealth.status === 'offline' && reference.status === 'loading') {
      setReference({ status: 'error', message: '本地受控代理离线，暂无法获取参照目录' });
    }
  }, [proxyHealth.status, reference.status, loadReference]);

  useEffect(() => {
    const syncLayout = () => {
      const nextCompact = window.innerWidth <= 900;
      if (nextCompact === compactLayout.current) return;
      compactLayout.current = nextCompact;
      setCompact(nextCompact);
      setSidebarOpen(!nextCompact);
    };
    window.addEventListener('resize', syncLayout);
    return () => window.removeEventListener('resize', syncLayout);
  }, []);

  useEffect(() => {
    const opened = sidebarOpen && !previousSidebarOpen.current;
    const closed = !sidebarOpen && previousSidebarOpen.current;
    previousSidebarOpen.current = sidebarOpen;
    if (!compact) return;
    if (closed) toggleRef.current?.focus();
  }, [compact, sidebarOpen]);

  useEffect(() => {
    if (!compact || !sidebarOpen) return;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSidebarOpen(false); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [compact, sidebarOpen]);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2800); };
  const updateProfile = (next: EndpointProfile) => setProfile(next);

  const restoreHistory = async (historyId: string) => {
    if (!await refreshProxyHealth()) { notify('本地受控代理不可用，无法还原历史'); return; }
    setHistoryLoading(true);
    try {
      const restored = await restoreEndpointHistory(historyId);
      const now = new Date().toISOString();
      const next: EndpointProfile = {
        ...restored,
        id: uid(),
        headers: restored.headers.map((item) => ({ ...item, id: uid() })),
        queryParams: restored.queryParams.map((item) => ({ ...item, id: uid() })),
        createdAt: now,
        updatedAt: now,
      };
      setProfile(next);
      setRun(undefined);
      setSelectedId(undefined);
      notify(next.apiKey ? '已从后端历史还原端点和 API Key，可直接重新探测' : '已从后端历史还原端点配置');
    } catch (error) {
      notify(`还原失败：${error instanceof Error ? error.message : '历史记录不可用'}`);
      await refreshEndpointHistory();
    } finally {
      setHistoryLoading(false);
    }
  };

  const clearHistory = async () => {
    if (!window.confirm('清空当前后端进程中的全部探测历史和 API Key？此操作无法撤销。')) return;
    setHistoryLoading(true);
    try {
      await clearEndpointHistory();
      setEndpointHistory([]);
      notify('后端探测历史和内存密钥已清空');
    } catch (error) {
      notify(`清空失败：${error instanceof Error ? error.message : '后端不可用'}`);
    } finally {
      setHistoryLoading(false);
    }
  };

  const startProbe = async () => {
    if (!profile.baseURL.trim()) { notify('请先填写端点 URL'); return; }
    if (!await refreshProxyHealth()) { notify('本地受控代理不可用，请启动代理后重试'); return; }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setSelectedId(undefined);
    setActiveView('logs');
    const result = await discover(profile, controller.signal, setRun);
    void refreshEndpointHistory();
    setProfile((current) => ({
      ...current,
      name: result.endpointName ?? current.name,
      baseURL: result.endpointBaseURL ?? current.baseURL,
      queryParams: result.endpointQueryParams?.map((item) => ({ ...item, id: uid() })) ?? current.queryParams,
      updatedAt: new Date().toISOString(),
    }));
    if (result.models.length) { setSelectedId(result.models[0].id); setActiveView('models'); }
    notify(result.status === 'success' ? `探测完成：发现 ${result.models.length} 个模型` : result.status === 'partial' ? `发现 ${result.models.length} 个模型，但认证诊断存在问题` : result.status === 'cancelled' ? '探测已取消' : '探测未完成，请查看错误详情');
  };

  const runValidation = async (items: CapabilityKey[]) => {
    if (!validationModel || !run) return;
    if (!await refreshProxyHealth()) { notify('本地受控代理不可用，未发送验证请求'); return; }
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
    if (result) { setRun((current) => current ? { ...current, models: current.models.map((item) => item.id === result.id ? result : item) } : current); notify(result.status === 'partial' ? '验证已取消，已保留完成的证据' : '模型能力验证完成（含名称真实性校验）'); }
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
    <header className="app-header"><div className="brand"><div className="brand-mark"><Radio size={18} /></div><div><h1>LLM API 端点探测器</h1><span>Endpoint Probe Workbench</span></div></div><div className="header-status"><button className={`header-health health-${proxyHealth.status}`} aria-label={proxyHealth.status === 'online' ? '本地代理已连接' : proxyHealth.status === 'offline' ? '本地代理离线' : '正在检查代理'} title={`${proxyHealth.message}${proxyHealth.lastCheckedAt ? `；检查于 ${new Date(proxyHealth.lastCheckedAt).toLocaleTimeString()}` : ''}`} onClick={() => void refreshProxyHealth()}>{proxyHealth.status === 'online' ? <ShieldCheck size={14} /> : proxyHealth.status === 'offline' ? <ShieldAlert size={14} /> : <LoaderCircle className="spin" size={14} />}<span className="health-label-full">{proxyHealth.status === 'online' ? '本地代理已连接' : proxyHealth.status === 'offline' ? '本地代理离线' : '正在检查代理'}</span><span className="health-label-compact">{proxyHealth.status === 'online' ? '在线' : proxyHealth.status === 'offline' ? '离线' : '检查中'}</span><RefreshCw className="health-refresh" size={12} /></button><span className="response-limit"><Database size={14} />{proxyHealth.status === 'online' ? responseLimitLabel(proxyHealth.maxResponseBytes) : '响应上限 未确认'}</span></div></header>
    <div className={`workspace ${sidebarOpen ? '' : 'sidebar-collapsed'} ${selectedModel ? 'detail-open' : ''}`}>
      {sidebarOpen && <><button className="workspace-backdrop" aria-label="关闭配置遮罩" onClick={() => setSidebarOpen(false)} /><EndpointPanel profile={profile} history={endpointHistory} historyLoading={historyLoading} running={run?.status === 'running' || Boolean(run?.models.some((model) => model.status === 'validating'))} proxyStatus={proxyHealth.status} proxyMessage={proxyHealth.message} onChange={updateProfile} onClose={() => setSidebarOpen(false)} onRestoreHistory={(id) => void restoreHistory(id)} onClearHistory={() => void clearHistory()} onProbe={startProbe} onCancel={() => controllerRef.current?.abort()} /></>}
      <main className="main-workspace">
        <div className="workspace-heading"><div className="heading-left"><button ref={toggleRef} className="icon-button" title={sidebarOpen ? '收起配置' : '展开配置'} aria-expanded={sidebarOpen} onClick={() => setSidebarOpen(!sidebarOpen)}>{sidebarOpen ? <PanelLeftClose size={17} /> : <PanelLeftOpen size={17} />}</button><div><span className="eyebrow">工作台</span><h2>{profile.name}</h2></div></div><div className="run-state"><span className={`run-dot run-${run?.status || 'idle'}`} />{run ? ({ running: '探测进行中', success: '探测完成', partial: '部分完成', error: '探测失败', cancelled: '已取消', idle: '未开始' }[run.status]) : '等待探测'}</div></div>
        <div className="view-tabs"><button className={activeView === 'models' ? 'active' : ''} onClick={() => setActiveView('models')}><Braces size={15} />模型结果 <span>{run?.models.length ?? 0}</span></button><button className={activeView === 'logs' ? 'active' : ''} onClick={() => setActiveView('logs')}><ScrollText size={15} />探测与请求 <span>{run?.requests.length ?? 0}</span></button></div>
        {activeView === 'models' ? <ModelsTable models={filteredModels} selectedId={selectedId} search={search} capabilityFilter={capabilityFilter} confidenceFilter={confidenceFilter} protocolFilter={protocolFilter} statusFilter={statusFilter} sortKey={sortKey} sortDirection={sortDirection} onSearch={setSearch} onCapabilityFilter={setCapabilityFilter} onConfidenceFilter={setConfidenceFilter} onProtocolFilter={setProtocolFilter} onStatusFilter={setStatusFilter} onSort={handleSort} onSelect={(model) => setSelectedId(model.id)} /> : <ProbeLog run={run} />}
      </main>
      {selectedModel && <ModelDetail model={selectedModel} requests={run?.requests ?? []} onClose={() => setSelectedId(undefined)} canValidate={profile.allowValidation} onValidate={() => setValidationModel(selectedModel)} reference={reference} onRetryReference={() => { referenceRequested.current = true; void loadReference(); }} />}
    </div>
    {validationModel && <ValidationDialog modelName={validationModel.displayName} interfaces={modelProbeInterfaces(validationModel).length} generationInterfaces={modelGenerationInterfaces(validationModel).length} onClose={() => setValidationModel(undefined)} onStart={runValidation} />}
    {toast && <div className="toast"><Activity size={15} />{toast}</div>}
  </div>;
}
