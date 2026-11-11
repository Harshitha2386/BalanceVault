import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  ArrowUpRight,
  BadgeCheck,
  Building2,
  ClipboardList,
  FileCheck2,
  FileClock,
  KeyRound,
  LayoutDashboard,
  LogOut,
  RefreshCw,
  ShieldCheck,
  Users,
  Wallet,
} from 'lucide-react';
import {
  Link,
  Navigate,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from 'react-router-dom';
import { ApiError, api } from './api.js';
import { useAuth } from './auth.jsx';
import { formatMinorCurrency, parseRupeesToMinor } from './money.js';
import {
  Alert,
  Brand,
  ConfirmDialog,
  EmptyState,
  Field,
  Loading,
  Money,
  PageTitle,
  Pagination,
  SelectField,
  SidebarLink,
  StatusBadge,
  TransactionAmount,
} from './ui.jsx';

function dashboardPath(user) {
  return user?.role === 'ADMIN' ? '/admin' : '/app';
}

function formatDate(value, options = {}) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('en-IN', {
      dateStyle: 'medium',
      ...(options.time ? { timeStyle: 'short' } : {}),
    }).format(date);
}

function displayError(error) {
  if (error instanceof ApiError) {
    if (error.code === 'INSUFFICIENT_FUNDS') return 'There are not enough available funds for this transfer.';
    if (error.code === 'ACCOUNT_NOT_ACTIVE') return 'Both accounts must be active to complete this request.';
    if (error.code === 'CURRENCY_MISMATCH') return 'The accounts use different currencies.';
    if (error.code === 'IDEMPOTENCY_KEY_REUSED') return 'This request key was already used for different details. Start a new request.';
    if (error.code === 'ACTIVE_APPLICATION_EXISTS') return 'You already have an active onboarding application.';
    if (error.code === 'APPLICATION_ALREADY_DECIDED') return 'This application has already been reviewed.';
    if (error.code === 'LAST_ACTIVE_ADMIN') return 'The last active administrator cannot be disabled.';
    return error.message;
  }
  return error?.message || 'Something went wrong. Please try again.';
}

function useRemoteData(load, dependencies = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await load());
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setLoading(false);
    }
  // load is expected to be memoized by the caller or stable for the supplied dependencies.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, dependencies);
  useEffect(() => { reload(); }, [reload]);
  return { data, loading, error, reload, setData };
}

function RetryButton({ onRetry }) {
  return <button className="button button-quiet button-small retry-button" onClick={onRetry}>Try again</button>;
}

function App() {
  const { user, loading, sessionError, refresh } = useAuth();
  if (loading) return <Loading label="Checking your secure session" />;
  if (sessionError) {
    return (
      <main className="connection-screen">
        <Brand />
        <section className="auth-card">
          <div className="auth-icon"><ShieldCheck size={23} /></div>
          <h1>Secure session unavailable</h1>
          <p className="muted">{sessionError}</p>
          <button className="button button-primary button-wide" onClick={() => refresh().catch(() => {})}>Retry connection</button>
        </section>
      </main>
    );
  }
  return (
    <Routes>
      <Route path="/" element={<Navigate to={user ? dashboardPath(user) : '/login'} replace />} />
      <Route path="/login" element={user ? <Navigate to={dashboardPath(user)} replace /> : <AuthScreen mode="login" />} />
      <Route path="/register" element={user ? <Navigate to={dashboardPath(user)} replace /> : <AuthScreen mode="register" />} />
      <Route element={<RoleRoute role="ACCOUNT_HOLDER" />}>
        <Route path="/app" element={<CustomerLayout />}>
          <Route index element={<CustomerDashboard />} />
          <Route path="accounts/:id" element={<CustomerAccountDetail />} />
          <Route path="history" element={<TransactionHistory />} />
          <Route path="transfer" element={<TransferPage />} />
          <Route path="onboarding" element={<OnboardingPage />} />
        </Route>
      </Route>
      <Route element={<RoleRoute role="ADMIN" />}>
        <Route path="/admin" element={<AdminLayout />}>
          <Route index element={<AdminOverview />} />
          <Route path="users" element={<AdminUsers />} />
          <Route path="users/:id" element={<AdminUserDetail />} />
          <Route path="onboarding" element={<AdminOnboarding />} />
          <Route path="accounts" element={<AdminAccounts />} />
          <Route path="ledger" element={<LedgerVerification />} />
          <Route path="audit" element={<AuditLog />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to={user ? dashboardPath(user) : '/login'} replace />} />
    </Routes>
  );
}

function RoleRoute({ role }) {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  if (user.role !== role) return <Navigate to={dashboardPath(user)} replace />;
  return <Outlet />;
}

function AuthScreen({ mode }) {
  const isRegister = mode === 'register';
  const navigate = useNavigate();
  const location = useLocation();
  const { acceptUser, sessionExpired } = useAuth();
  const [form, setForm] = useState({ email: '', password: '', fullName: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState(
    location.state?.registered
      ? 'Your account is ready. Sign in to continue to onboarding.'
      : sessionExpired ? 'Your session expired or was revoked. Sign in to continue.' : '',
  );

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (isRegister) {
        await api.post('/auth/register', {
          email: form.email.trim(),
          fullName: form.fullName.trim(),
          password: form.password,
        });
        setNotice('Your account is ready. Sign in to continue to onboarding.');
        navigate('/login', { replace: true, state: { registered: true } });
        return;
      }
      const result = await api.post('/auth/login', {
        email: form.email.trim(),
        password: form.password,
      });
      acceptUser(result.user);
      navigate(dashboardPath(result.user), { replace: true });
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-decoration" aria-hidden="true" />
      <div className="auth-shell">
        <Brand />
        <div className="auth-card">
          <div className="auth-icon"><ShieldCheck size={23} /></div>
          <p className="eyebrow">{isRegister ? 'GET STARTED' : 'SECURE ACCESS'}</p>
          <h1>{isRegister ? 'Create your account' : 'Welcome back'}</h1>
          <p className="muted">{isRegister ? 'Set up your BalanceVault profile to begin onboarding.' : 'Sign in to your secure BalanceVault workspace.'}</p>
          {notice && <Alert tone="success">{notice}</Alert>}
          <Alert>{error}</Alert>
          <form onSubmit={submit} className="form-stack">
            {isRegister && (
              <Field
                label="Full name"
                autoComplete="name"
                maxLength={120}
                required
                value={form.fullName}
                onChange={(event) => setForm({ ...form, fullName: event.target.value })}
              />
            )}
            <Field
              label="Email address"
              type="email"
              autoComplete="email"
              maxLength={254}
              required
              value={form.email}
              onChange={(event) => setForm({ ...form, email: event.target.value })}
            />
            <Field
              label="Password"
              type="password"
              autoComplete={isRegister ? 'new-password' : 'current-password'}
              minLength={isRegister ? 12 : 1}
              maxLength={128}
              required
              value={form.password}
              onChange={(event) => setForm({ ...form, password: event.target.value })}
              hint={isRegister ? 'Use at least 12 characters and a mix of character types.' : undefined}
            />
            <button className="button button-primary button-wide" disabled={busy}>
              {busy ? 'Please wait…' : isRegister ? 'Create account' : 'Sign in securely'}
            </button>
          </form>
          <p className="auth-switch">
            {isRegister ? 'Already have an account?' : 'New to BalanceVault?'}{' '}
            <Link to={isRegister ? '/login' : '/register'}>{isRegister ? 'Sign in' : 'Create an account'}</Link>
          </p>
        </div>
        <p className="auth-footnote"><ShieldCheck size={14} /> Protected with secure server-side sessions</p>
      </div>
    </main>
  );
}

function WorkspaceLayout({ admin = false }) {
  const { user, clearUser } = useAuth();
  const navigate = useNavigate();
  const [logoutBusy, setLogoutBusy] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const base = admin ? '/admin' : '/app';

  async function logout() {
    setLogoutBusy(true);
    setLogoutError('');
    try {
      await api.post('/auth/logout', {});
      clearUser();
      navigate('/login', { replace: true });
    } catch {
      setLogoutError('Sign out could not be confirmed. Check your connection and try again.');
    } finally {
      setLogoutBusy(false);
    }
  }

  return (
    <div className="workspace">
      <a className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-white focus:px-4 focus:py-3 focus:text-sm focus:font-semibold focus:text-blue-800 focus:shadow-lg" href="#workspace-main">
        Skip to main content
      </a>
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">{admin ? 'ADMINISTRATION' : 'YOUR BANKING'}</div>
        <nav className="side-nav" aria-label="Main navigation">
          {admin ? (
            <>
              <SidebarLink to="/admin" icon={LayoutDashboard}>Overview</SidebarLink>
              <SidebarLink to="/admin/users" icon={Users}>Users</SidebarLink>
              <SidebarLink to="/admin/onboarding" icon={FileCheck2}>Onboarding</SidebarLink>
              <SidebarLink to="/admin/accounts" icon={Building2}>Accounts</SidebarLink>
              <SidebarLink to="/admin/ledger" icon={Activity}>Ledger checks</SidebarLink>
              <SidebarLink to="/admin/audit" icon={ClipboardList}>Audit trail</SidebarLink>
            </>
          ) : (
            <>
              <SidebarLink to="/app" icon={LayoutDashboard}>Overview</SidebarLink>
              <SidebarLink to="/app/history" icon={FileClock}>Transactions</SidebarLink>
              <SidebarLink to="/app/transfer" icon={ArrowLeftRight}>Send money</SidebarLink>
              <SidebarLink to="/app/onboarding" icon={BadgeCheck}>Onboarding</SidebarLink>
            </>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="security-note"><ShieldCheck size={17} /><span>Your session is protected and monitored.</span></div>
          <button className="nav-link logout-button" onClick={logout} disabled={logoutBusy}>
            <LogOut size={18} /><span>{logoutBusy ? 'Signing out…' : 'Sign out'}</span>
          </button>
        </div>
      </aside>
      <div className="main-column">
        <header className="topbar">
          <div className="mobile-brand"><Brand compact /></div>
          <div className="topbar-spacer" />
          <div className="profile-chip">
            <span className="avatar">{(user?.fullName || user?.email || 'U').slice(0, 1).toUpperCase()}</span>
            <span className="profile-copy"><strong>{user?.fullName || 'BalanceVault user'}</strong><small>{admin ? 'Administrator' : 'Account holder'}</small></span>
            <StatusBadge value={user?.status} />
          </div>
            <button className="mobile-logout" onClick={logout} disabled={logoutBusy} aria-label="Sign out">
              <LogOut size={15} /><span>{logoutBusy ? 'Wait…' : 'Sign out'}</span>
            </button>
        </header>
        <main className="content" id="workspace-main">
          <Alert>{logoutError}</Alert>
          {user?.mustChangePassword && (
            <Alert tone="warning">
              Your administrator requires a password change. This backend does not currently expose a password-change endpoint; contact the administrator before using sensitive account functions.
            </Alert>
          )}
          <Outlet />
        </main>
        <footer className="site-footer">BalanceVault · Secure banking experience · Synthetic challenge project</footer>
      </div>
    </div>
  );
}

function CustomerLayout() {
  return <WorkspaceLayout />;
}

function AdminLayout() {
  return <WorkspaceLayout admin />;
}

function CustomerDashboard() {
  const { user } = useAuth();
  const { data: accounts, loading, error, reload } = useRemoteData(
    async () => (await api.get('/accounts')).accounts,
    [],
  );
  const [recent, setRecent] = useState(null);
  const [recentLoading, setRecentLoading] = useState(true);
  const [historyError, setHistoryError] = useState('');

  const loadRecent = useCallback(async () => {
    setRecentLoading(true);
    setHistoryError('');
    try {
      const result = await api.get('/transactions?page=1&limit=5');
      setRecent(result.transactions);
    } catch (requestError) {
      setHistoryError(displayError(requestError));
    } finally {
      setRecentLoading(false);
    }
  }, []);
  useEffect(() => { loadRecent(); }, [loadRecent]);

  const total = useMemo(() => (
    (accounts || []).reduce((sum, account) => sum + BigInt(account.balanceMinor || '0'), 0n).toString()
  ), [accounts]);

  return (
    <>
      <PageTitle eyebrow="ACCOUNT OVERVIEW" title={`Good day, ${(user?.fullName || '').split(' ')[0] || 'there'}`} description="A clear view of your accounts and recent activity." action={<button className="button button-quiet" onClick={reload}><RefreshCw size={16} /> Refresh</button>} />
      <Alert>{error}</Alert>
      {loading ? <Loading /> : error && !accounts ? <RetryButton onRetry={reload} /> : (
        <>
          <section className="summary-grid">
            <div className="summary-card summary-primary">
              <div className="summary-label"><span>Combined account balance</span><Wallet size={19} /></div>
              <div className="summary-value"><Money minor={total} /></div>
              <p>Across {accounts.length} {accounts.length === 1 ? 'customer account' : 'customer accounts'}</p>
            </div>
            <div className="summary-card">
              <div className="summary-label"><span>Active accounts</span><Building2 size={19} /></div>
              <div className="summary-value">{accounts.filter((account) => account.status === 'ACTIVE').length}</div>
              <p>Only active accounts can send or receive transfers.</p>
            </div>
            <div className="summary-card">
              <div className="summary-label"><span>Recent activity</span><Activity size={19} /></div>
              <div className="summary-value">{recentLoading ? '—' : recent?.length ?? '—'}</div>
              <p>Latest transactions available in your history.</p>
            </div>
          </section>
          <section className="panel">
            <div className="section-heading"><div><h2>Your accounts</h2><p className="muted">Balances are shown in Indian rupees.</p></div><Link className="text-link" to="/app/onboarding">Onboarding status <ArrowUpRight size={15} /></Link></div>
            {accounts.length === 0 ? <EmptyState title="No account yet">Complete onboarding to request your first customer account.</EmptyState> : (
              <div className="account-grid">
                {accounts.map((account) => <article className="account-card" key={account.id}>
                  <div className="account-card-top"><span className="account-icon"><Wallet size={18} /></span><StatusBadge value={account.status} /></div>
                  <p className="account-caption">CUSTOMER ACCOUNT</p>
                  <h3>{account.accountNumber}</h3>
                  <p className="account-balance"><Money minor={account.balanceMinor} currency={account.currency} /></p>
                  <div className="account-card-bottom"><span>{account.currency}</span><Link to={`/app/accounts/${encodeURIComponent(account.id)}`}>Account details <ArrowUpRight size={14} /></Link></div>
                </article>)}
              </div>
            )}
          </section>
          <section className="panel">
            <div className="section-heading"><div><h2>Recent transactions</h2><p className="muted">Latest posted activity on your accounts.</p></div><Link className="text-link" to="/app/history">View all <ArrowUpRight size={15} /></Link></div>
            <Alert>{historyError}</Alert>
            {recentLoading ? <Loading label="Loading recent transactions" /> : historyError ? <RetryButton onRetry={loadRecent} /> : recent?.length ? <TransactionTable transactions={recent} /> : <EmptyState title="No transactions yet">Transactions will appear here after activity posts to your account.</EmptyState>}
          </section>
        </>
      )}
    </>
  );
}

function CustomerAccountDetail() {
  const { id } = useParams();
  const [account, setAccount] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    setLoading(true);
    api.get(`/accounts/${encodeURIComponent(id)}`)
      .then((result) => {
        if (active) setAccount(result.account);
      })
      .catch((requestError) => {
        if (active) setError(displayError(requestError));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [id]);

  return (
    <>
      <PageTitle eyebrow="ACCOUNT DETAILS" title="Your account" description="Only accounts owned by your signed-in profile are available here." />
      {loading ? <Loading /> : error ? <Alert>{error}</Alert> : account && (
        <section className="panel account-detail-panel">
          <div className="account-detail-head">
            <span className="account-icon"><Wallet size={19} /></span>
            <div><p className="account-caption">CUSTOMER ACCOUNT</p><h2>{account.accountNumber}</h2></div>
            <StatusBadge value={account.status} />
          </div>
          <p className="account-detail-balance"><Money minor={account.balanceMinor} currency={account.currency} /></p>
          <div className="detail-grid">
            <Detail label="Currency" value={account.currency} />
            <Detail label="Account status" value={account.status} />
            <Detail label="Opened" value={formatDate(account.createdAt)} />
            <Detail label="Account number" value={account.accountNumber} />
          </div>
          <p className="account-detail-note">Your account balance is maintained from posted ledger entries. The application cannot set the balance directly.</p>
        </section>
      )}
    </>
  );
}

function TransactionTable({ transactions }) {
  return (
    <div className="table-scroll"><table>
      <thead><tr><th>Transaction</th><th>Reference</th><th>Date</th><th>Amount</th><th>Type</th></tr></thead>
      <tbody>{transactions.map((transaction) => <tr key={transaction.id}>
        <td><strong>{transaction.type === 'FUNDING' ? 'Account funding' : transaction.type === 'TRANSFER' ? 'Transfer' : transaction.type}</strong><small className="table-sub">{transaction.id.slice(0, 8)}</small></td>
        <td className="mono">{transaction.reference}</td>
        <td>{formatDate(transaction.createdAt, { time: true })}</td>
        <td><TransactionAmount entries={transaction.entries} /></td>
        <td><StatusBadge value={transaction.type} /></td>
      </tr>)}</tbody>
    </table></div>
  );
}

function TransactionHistory() {
  const [page, setPage] = useState(1);
  const [type, setType] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const query = new URLSearchParams({ page: String(page), limit: '20' });
      if (type) query.set('type', type);
      setResult(await api.get(`/transactions?${query}`));
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setLoading(false);
    }
  }, [page, type]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageTitle eyebrow="YOUR ACTIVITY" title="Transactions" description="Review posted activity across your accounts." />
      <section className="panel">
        <div className="toolbar">
          <SelectField label="Transaction type" value={type} onChange={(event) => { setType(event.target.value); setPage(1); }}>
            <option value="">All activity</option><option value="TRANSFER">Transfers</option><option value="FUNDING">Funding</option><option value="REVERSAL">Reversals</option>
          </SelectField>
          <button className="button button-quiet" onClick={load}><RefreshCw size={16} /> Refresh</button>
        </div>
        <Alert>{error}</Alert>
        {loading ? <Loading /> : error && !result ? <RetryButton onRetry={load} /> : result?.transactions.length ? <TransactionTable transactions={result.transactions} /> : <EmptyState title="No matching transactions">Try another filter or return after your account has activity.</EmptyState>}
        {result && <Pagination {...result.pagination} onPage={setPage} />}
      </section>
    </>
  );
}

function TransferPage() {
  const { data: accounts, loading: accountsLoading, error: accountError, reload: reloadAccounts } = useRemoteData(
    async () => (await api.get('/accounts')).accounts,
    [],
  );
  const [destinationAccountId, setDestinationAccountId] = useState('');
  const [amount, setAmount] = useState('');
  const [attempt, setAttempt] = useState(null);
  const [review, setReview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(null);

  function updateField(field, value) {
    if (field === 'amount') setAmount(value);
    else setDestinationAccountId(value);
    setAttempt(null);
    setReview(null);
    setSuccess(null);
    setError('');
  }

  function reviewTransfer(event) {
    event.preventDefault();
    setError('');
    setSuccess(null);
    let amountMinor;
    try {
      amountMinor = parseRupeesToMinor(amount);
    } catch (validationError) {
      setError(validationError.message);
      return;
    }
    if (!destinationAccountId) {
      setError('Enter the destination customer account UUID.');
      return;
    }
    setReview({ destinationAccountId, amountMinor });
  }

  async function confirmTransfer() {
    if (!review) return;
    const sameAttempt = attempt
      && attempt.destinationAccountId === review.destinationAccountId
      && attempt.amountMinor === review.amountMinor;
    const idempotencyKey = sameAttempt ? attempt.key : crypto.randomUUID();
    setAttempt({ ...review, key: idempotencyKey });
    setBusy(true);
    try {
      const result = await api.post('/transfers', review, {
        'Idempotency-Key': idempotencyKey,
      });
      setSuccess(result);
      setAttempt(null);
      setAmount('');
      setDestinationAccountId('');
      setReview(null);
    } catch (requestError) {
      setError(displayError(requestError));
      setReview(null);
    } finally {
      setBusy(false);
    }
  }

  const activeAccounts = (accounts || []).filter((account) => account.status === 'ACTIVE');
  return (
    <>
      <PageTitle eyebrow="MOVE MONEY" title="Send a transfer" description="Transfers are posted atomically and protected against duplicate submissions." />
      <div className="two-column-layout">
        <section className="panel form-panel">
          <div className="panel-heading-icon"><span className="feature-icon"><ArrowLeftRight size={20} /></span><div><h2>Transfer details</h2><p className="muted">Choose a destination and enter an amount in INR.</p></div></div>
          <Alert>{accountError}</Alert>
          <Alert>{error}</Alert>
          {success && <Alert tone="success">Transfer posted{success.transaction?.reference ? ` · ${success.transaction.reference}` : ''}. Amount: <Money minor={success.transaction?.amountMinor} />.</Alert>}
          {accountsLoading ? <Loading label="Loading your accounts" /> : accountError && !accounts ? <RetryButton onRetry={reloadAccounts} /> : activeAccounts.length === 0 ? <EmptyState title="No active source account">An active customer account is required to send a transfer.</EmptyState> : (
            <form className="form-stack" onSubmit={reviewTransfer}>
              <div className="source-summary">
                <span className="source-mark"><Wallet size={17} /></span>
                <span><small>FROM YOUR ACCOUNT</small><strong>{activeAccounts[0].accountNumber}</strong></span>
                <span className="source-balance"><Money minor={activeAccounts[0].balanceMinor} /></span>
              </div>
              <Field label="Destination account ID" inputMode="text" autoComplete="off" required value={destinationAccountId} onChange={(event) => updateField('destinationAccountId', event.target.value)} hint="Use the recipient account UUID. The transfer API accepts account IDs, not account numbers." />
              <Field label="Amount (INR)" type="text" inputMode="decimal" placeholder="0.00" autoComplete="off" required value={amount} onChange={(event) => updateField('amount', event.target.value)} hint="Up to ₹10,00,000.00. Amounts are converted exactly to paise." />
              <div className="form-note"><ShieldCheck size={16} /><span>Your source account is selected by the server from your signed-in identity. Transfers cannot be reversed in this interface.</span></div>
              <button className="button button-primary button-wide" disabled={busy}>{attempt ? 'Review retry' : 'Review transfer'} <ArrowUpRight size={16} /></button>
            </form>
          )}
        </section>
        <aside className="info-card">
          <span className="feature-icon feature-icon-teal"><KeyRound size={20} /></span>
          <h2>Protected by design</h2>
          <ul className="check-list"><li>Server verifies source ownership.</li><li>Account state and available funds are checked.</li><li>Database locks prevent concurrent overdrafts.</li><li>Retrying the same request will not duplicate it.</li></ul>
          <div className="info-divider" /><p className="muted">A request key is held only in this page's memory and reused for an unchanged retry. It is never stored in browser storage.</p>
        </aside>
      </div>
      {review && <ConfirmDialog
        title={attempt ? 'Retry this transfer?' : 'Confirm this transfer'}
        message={`Send ${formatMinorCurrency(review.amountMinor)} to the recipient account ending ${review.destinationAccountId.slice(-8)}? This transfer cannot be reversed here.`}
        confirmLabel={attempt ? 'Retry transfer' : 'Confirm transfer'}
        busy={busy}
        onCancel={() => setReview(null)}
        onConfirm={confirmTransfer}
      />}
    </>
  );
}

function OnboardingPage() {
  const { data: applications, loading, error, reload } = useRemoteData(
    async () => (await api.get('/onboarding/applications/me')).applications,
    [],
  );
  const [form, setForm] = useState({
    legalName: '',
    dateOfBirth: '',
    phone: '',
    addressLine: '',
    city: '',
    country: 'IN',
  });
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [notice, setNotice] = useState('');
  const active = applications?.some((application) => ['PENDING', 'APPROVED'].includes(application.status));

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setFormError('');
    setNotice('');
    try {
      await api.post('/onboarding/applications', form);
      setNotice('Your application has been submitted for review.');
      setForm({ legalName: '', dateOfBirth: '', phone: '', addressLine: '', city: '', country: 'IN' });
      await reload();
    } catch (requestError) {
      setFormError(displayError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle eyebrow="CUSTOMER VERIFICATION" title="Onboarding" description="Submit your details and track the review status of your application." action={<button className="button button-quiet" onClick={reload}><RefreshCw size={16} /> Refresh</button>} />
      <Alert>{error}</Alert>
      <div className="two-column-layout onboarding-layout">
        <section className="panel">
          <h2>Application status</h2>
          <p className="muted">Applications are reviewed by the BalanceVault administration team.</p>
          {loading ? <Loading /> : error && !applications ? <RetryButton onRetry={reload} /> : applications?.length ? <div className="application-list">{applications.map((application) => (
            <article className="application-card" key={application.id}>
              <div className="application-card-title"><div><strong>{application.legalName}</strong><small>Submitted {formatDate(application.createdAt)}</small></div><StatusBadge value={application.status} /></div>
              <div className="application-meta"><span>{application.city}, {application.country}</span><span>Application {application.id.slice(0, 8)}</span></div>
              {application.reviewNote && <p className="review-note">{application.reviewNote}</p>}
              {application.reviewedAt && <small className="muted">Reviewed {formatDate(application.reviewedAt)}</small>}
            </article>
          ))}</div> : <EmptyState title="No application submitted">Complete the form to begin identity and account onboarding.</EmptyState>}
        </section>
        <section className="panel">
          <h2>Personal details</h2><p className="muted">Provide accurate information for account review.</p>
          <Alert>{formError}</Alert><Alert tone="success">{notice}</Alert>
          {error && !applications ? <RetryButton onRetry={reload} /> : loading ? <Loading label="Checking your application status" /> : active ? <div className="callout"><FileClock size={18} /> An application is already pending or approved. A second active application cannot be submitted.</div> : (
            <form className="form-stack" onSubmit={submit}>
              <Field label="Legal name" required maxLength={120} value={form.legalName} onChange={(event) => setForm({ ...form, legalName: event.target.value })} />
              <Field label="Date of birth" type="date" required max={new Date().toISOString().slice(0, 10)} value={form.dateOfBirth} onChange={(event) => setForm({ ...form, dateOfBirth: event.target.value })} />
              <Field label="Phone" type="tel" required maxLength={20} value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} />
              <Field label="Address" required maxLength={200} value={form.addressLine} onChange={(event) => setForm({ ...form, addressLine: event.target.value })} />
              <div className="form-row">
                <Field label="City" required maxLength={100} value={form.city} onChange={(event) => setForm({ ...form, city: event.target.value })} />
                <Field label="Country code" required maxLength={2} value={form.country} onChange={(event) => setForm({ ...form, country: event.target.value.toUpperCase() })} hint="Two-letter code, e.g. IN" />
              </div>
              <button className="button button-primary" disabled={busy}>{busy ? 'Submitting…' : 'Submit application'} <ArrowUpRight size={16} /></button>
            </form>
          )}
        </section>
      </div>
    </>
  );
}

function AdminOverview() {
  const [counts, setCounts] = useState({ users: null, applications: null, accounts: null });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    Promise.all([
      api.get('/admin/users?page=1&limit=1'),
      api.get('/admin/onboarding/applications?status=PENDING&page=1&limit=1'),
      api.get('/admin/accounts?page=1&limit=1'),
    ]).then(([users, applications, accounts]) => {
      setCounts({
        users: users.pagination.total,
        applications: applications.pagination.total,
        accounts: accounts.pagination.total,
      });
    }).catch((requestError) => setError(displayError(requestError)))
      .finally(() => setLoading(false));
  }, []);
  return (
    <>
      <PageTitle eyebrow="CONTROL CENTER" title="Administration overview" description="Review operational queues and verify the integrity of the ledger." />
      <Alert>{error}</Alert>
      {loading ? <Loading /> : <>
        <section className="summary-grid admin-summary-grid">
          <MetricCard icon={Users} label="Registered users" value={counts.users} />
          <MetricCard icon={FileCheck2} label="Pending applications" value={counts.applications} accent />
          <MetricCard icon={Building2} label="Accounts" value={counts.accounts} />
        </section>
        <div className="admin-quick-grid">
          <QuickCard icon={FileCheck2} title="Review onboarding" description="Review submitted applications and record an approval decision." to="/admin/onboarding" />
          <QuickCard icon={Activity} title="Verify ledger" description="Recompute cached balances against authoritative ledger entries." to="/admin/ledger" />
          <QuickCard icon={ClipboardList} title="Audit trail" description="Inspect paginated administrative and financial events." to="/admin/audit" />
        </div>
        <div className="callout callout-neutral"><ShieldCheck size={18} /> Administrative actions are authorized by the backend on every request. Dashboard visibility is not an access-control boundary.</div>
      </>}
    </>
  );
}

function MetricCard({ icon: Icon, label, value, accent = false }) {
  return <div className={`metric-card ${accent ? 'metric-card-accent' : ''}`}><span className="metric-icon"><Icon size={19} /></span><div><small>{label}</small><strong>{value?.toLocaleString('en-IN') ?? '—'}</strong></div></div>;
}

function QuickCard({ icon: Icon, title, description, to }) {
  return <Link className="quick-card" to={to}><span className="feature-icon"><Icon size={20} /></span><strong>{title}</strong><p>{description}</p><span className="quick-link">Open section <ArrowUpRight size={14} /></span></Link>;
}

function AdminUsers() {
  const { user: currentUser } = useAuth();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [role, setRole] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (status) params.set('status', status);
      if (role) params.set('role', role);
      setResult(await api.get(`/admin/users?${params}`));
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setLoading(false);
    }
  }, [page, status, role]);
  useEffect(() => { load(); }, [load]);

  async function openUser(user) {
    try {
      const resultDetails = await api.get(`/admin/users/${encodeURIComponent(user.id)}`);
      setSelected(resultDetails.user);
    } catch (requestError) {
      setError(displayError(requestError));
    }
  }

  async function changeStatus() {
    if (!confirm) return;
    setBusy(true);
    setError('');
    try {
      const response = await api.patch(`/admin/users/${encodeURIComponent(confirm.user.id)}/status`, { status: confirm.status });
      setSelected(response.user);
      setConfirm(null);
      await load();
    } catch (requestError) {
      setError(displayError(requestError));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle eyebrow="ACCESS MANAGEMENT" title="Users" description="Review user accounts and manage access without changing roles." action={<button className="button button-quiet" onClick={load}><RefreshCw size={16} /> Refresh</button>} />
      <Alert>{error}</Alert>
      <section className="panel">
        <div className="toolbar filter-toolbar">
          <SelectField label="Status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="DISABLED">Disabled</option></SelectField>
          <SelectField label="Role" value={role} onChange={(event) => { setRole(event.target.value); setPage(1); }}><option value="">All roles</option><option value="ACCOUNT_HOLDER">Account holder</option><option value="ADMIN">Admin</option></SelectField>
        </div>
        {loading ? <Loading /> : error && !result ? <RetryButton onRetry={load} /> : result?.users.length ? <div className="table-scroll"><table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Joined</th><th /></tr></thead><tbody>
          {result.users.map((user) => <tr key={user.id}>
            <td><strong>{user.fullName}</strong><small className="table-sub">{user.email}</small></td>
            <td>{user.role === 'ADMIN' ? 'Administrator' : 'Account holder'}</td><td><StatusBadge value={user.status} /></td><td>{formatDate(user.createdAt)}</td>
            <td className="table-actions"><button className="button button-quiet button-small" onClick={() => openUser(user)}>Details</button>{user.status === 'ACTIVE' ? <button className="button button-danger-quiet button-small" disabled={user.id === currentUser?.id} title={user.id === currentUser?.id ? 'You cannot disable your own admin account.' : undefined} onClick={() => setConfirm({ user, status: 'DISABLED' })}>{user.id === currentUser?.id ? 'Current admin' : 'Disable'}</button> : <button className="button button-quiet button-small" onClick={() => setConfirm({ user, status: 'ACTIVE' })}>Enable</button>}</td>
          </tr>)}
        </tbody></table></div> : <EmptyState title="No users found">No users match the selected filters.</EmptyState>}
        {result && <Pagination {...result.pagination} onPage={setPage} />}
      </section>
      {selected && <section className="panel detail-panel"><div className="section-heading"><div><h2>User details</h2><p className="muted">Safe account profile fields returned by the admin API.</p></div><button className="button button-quiet button-small" onClick={() => setSelected(null)}>Close</button></div><div className="detail-grid"><Detail label="Full name" value={selected.fullName} /><Detail label="Email" value={selected.email} /><Detail label="Role" value={selected.role} /><Detail label="Status" value={<StatusBadge value={selected.status} />} /><Detail label="Created" value={formatDate(selected.createdAt)} /><Detail label="Updated" value={formatDate(selected.updatedAt)} /></div></section>}
      {confirm && <ConfirmDialog title={`${confirm.status === 'DISABLED' ? 'Disable' : 'Enable'} this user?`} message={confirm.status === 'DISABLED' ? `This will revoke active sessions for ${confirm.user.email}. You cannot disable your own account or the last active administrator.` : `This will restore login access for ${confirm.user.email}. Existing sessions will not be restored.`} confirmLabel={confirm.status === 'DISABLED' ? 'Disable user' : 'Enable user'} danger={confirm.status === 'DISABLED'} busy={busy} onCancel={() => setConfirm(null)} onConfirm={changeStatus} />}
    </>
  );
}

function AdminUserDetail() {
  const { id } = useParams();
  const [user, setUser] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/admin/users/${encodeURIComponent(id)}`)
      .then((result) => setUser(result.user))
      .catch((requestError) => setError(displayError(requestError)));
  }, [id]);
  return <><PageTitle eyebrow="USER RECORD" title="User details" description="Administrative profile view." /><Alert>{error}</Alert>{!user ? !error && <Loading /> : <section className="panel"><div className="detail-grid"><Detail label="Full name" value={user.fullName} /><Detail label="Email" value={user.email} /><Detail label="Role" value={user.role} /><Detail label="Status" value={<StatusBadge value={user.status} />} /><Detail label="Created" value={formatDate(user.createdAt)} /><Detail label="Updated" value={formatDate(user.updatedAt)} /></div></section>}</>;
}

function Detail({ label, value }) {
  return <div className="detail-item"><small>{label}</small><strong>{value || '—'}</strong></div>;
}

function AdminOnboarding() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('PENDING');
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(null);
  const [reviewNote, setReviewNote] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (status) params.set('status', status);
      setResult(await api.get(`/admin/onboarding/applications?${params}`));
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setLoading(false);
    }
  }, [page, status]);
  useEffect(() => { load(); }, [load]);

  async function openApplication(application) {
    setNotice('');
    try {
      const response = await api.get(`/admin/onboarding/applications/${encodeURIComponent(application.id)}`);
      setSelected(response.application);
      setReviewNote(response.application.reviewNote || '');
    } catch (requestError) {
      setError(displayError(requestError));
    }
  }

  async function decide() {
    if (!confirm || !selected) return;
    setBusy(true);
    setError('');
    try {
      await api.patch(`/admin/onboarding/applications/${encodeURIComponent(selected.id)}/decision`, {
        decision: confirm,
        ...(reviewNote.trim() ? { reviewNote: reviewNote.trim() } : {}),
      });
      setNotice(`Application ${confirm.toLowerCase()} successfully.`);
      setSelected(null);
      setConfirm(null);
      await load();
    } catch (requestError) {
      setError(displayError(requestError));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle eyebrow="CUSTOMER REVIEW" title="Onboarding applications" description="Review customer-submitted information and record a decision." action={<button className="button button-quiet" onClick={load}><RefreshCw size={16} /> Refresh</button>} />
      <Alert>{error}</Alert><Alert tone="success">{notice}</Alert>
      <section className="panel">
        <div className="toolbar"><SelectField label="Application status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All applications</option><option value="PENDING">Pending</option><option value="APPROVED">Approved</option><option value="REJECTED">Rejected</option></SelectField></div>
        {loading ? <Loading /> : error && !result ? <RetryButton onRetry={load} /> : result?.applications.length ? <div className="table-scroll"><table><thead><tr><th>Applicant</th><th>Submitted</th><th>Location</th><th>Status</th><th /></tr></thead><tbody>{result.applications.map((application) => <tr key={application.id}><td><strong>{application.user.fullName}</strong><small className="table-sub">{application.user.email}</small></td><td>{formatDate(application.createdAt)}</td><td>{application.city}, {application.country}</td><td><StatusBadge value={application.status} /></td><td><button className="button button-quiet button-small" onClick={() => openApplication(application)}>Review</button></td></tr>)}</tbody></table></div> : <EmptyState title="No applications in this queue">There are no applications matching this status.</EmptyState>}
        {result && <Pagination {...result.pagination} onPage={setPage} />}
      </section>
      {selected && <section className="panel detail-panel">
        <div className="section-heading"><div><h2>Application review</h2><p className="muted">Submitted by {selected.user.fullName} · {selected.user.email}</p></div><button className="button button-quiet button-small" onClick={() => setSelected(null)}>Close</button></div>
        <div className="detail-grid"><Detail label="Legal name" value={selected.legalName} /><Detail label="Date of birth" value={formatDate(selected.dateOfBirth)} /><Detail label="Phone" value={selected.phone} /><Detail label="Address" value={`${selected.addressLine}, ${selected.city}, ${selected.country}`} /><Detail label="Submitted" value={formatDate(selected.createdAt, { time: true })} /><Detail label="Status" value={<StatusBadge value={selected.status} />} /></div>
        {selected.status === 'PENDING' && <>
          <label className="field review-field"><span>Review note (optional)</span><textarea rows="3" maxLength="500" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder="Add a concise note for the applicant" /></label>
          <div className="button-row"><button className="button button-primary" onClick={() => setConfirm('APPROVED')}>Approve application</button><button className="button button-danger-quiet" onClick={() => setConfirm('REJECTED')}>Reject application</button></div>
        </>}
      </section>}
      {confirm && <ConfirmDialog title={`${confirm === 'APPROVED' ? 'Approve' : 'Reject'} this application?`} message={confirm === 'APPROVED' ? 'Approval provisions the customer account as part of the backend transaction.' : 'The applicant will see the rejected status and any review note.'} confirmLabel={confirm === 'APPROVED' ? 'Approve' : 'Reject'} danger={confirm === 'REJECTED'} busy={busy} onCancel={() => setConfirm(null)} onConfirm={decide} />}
    </>
  );
}

function AdminAccounts() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState('');
  const [kind, setKind] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fundAmount, setFundAmount] = useState('');
  const [fundAttempt, setFundAttempt] = useState(null);
  const [notice, setNotice] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (status) params.set('status', status);
      if (kind) params.set('kind', kind);
      setResult(await api.get(`/admin/accounts?${params}`));
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setLoading(false);
    }
  }, [page, status, kind]);
  useEffect(() => { load(); }, [load]);

  async function changeStatus() {
    setBusy(true);
    setError('');
    try {
      await api.patch(`/admin/accounts/${encodeURIComponent(confirm.account.id)}/status`, { status: confirm.status });
      setNotice(`Account status changed to ${confirm.status}.`);
      setConfirm(null);
      await load();
    } catch (requestError) {
      setError(displayError(requestError));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  }

  async function fundAccount(account) {
    let amountMinor;
    try {
      amountMinor = parseRupeesToMinor(fundAmount);
    } catch (validationError) {
      setError(validationError.message);
      return;
    }
    const key = fundAttempt?.accountId === account.id && fundAttempt.amountMinor === amountMinor
      ? fundAttempt.key
      : crypto.randomUUID();
    setFundAttempt({ accountId: account.id, amountMinor, key });
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const resultFund = await api.post(`/admin/accounts/${encodeURIComponent(account.id)}/fund`, { amountMinor }, { 'Idempotency-Key': key });
      setNotice(`Funding posted for ${account.accountNumber}. Reference: ${resultFund.transaction.reference}.`);
      setFundAttempt(null);
      setFundAmount('');
      await load();
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageTitle eyebrow="ACCOUNT OPERATIONS" title="Accounts" description="Review account status and fund eligible customer accounts from the configured SYSTEM account." action={<button className="button button-quiet" onClick={load}><RefreshCw size={16} /> Refresh</button>} />
      <Alert>{error}</Alert><Alert tone="success">{notice}</Alert>
      <section className="panel">
        <div className="toolbar filter-toolbar">
          <SelectField label="Status" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}><option value="">All statuses</option><option value="ACTIVE">Active</option><option value="FROZEN">Frozen</option><option value="CLOSED">Closed</option></SelectField>
          <SelectField label="Account kind" value={kind} onChange={(event) => { setKind(event.target.value); setPage(1); }}><option value="">All kinds</option><option value="CUSTOMER">Customer</option><option value="SYSTEM">System</option></SelectField>
        </div>
        {loading ? <Loading /> : error && !result ? <RetryButton onRetry={load} /> : result?.accounts.length ? <div className="table-scroll"><table><thead><tr><th>Account</th><th>Owner</th><th>Kind</th><th>Balance</th><th>Status</th><th>Operations</th></tr></thead><tbody>{result.accounts.map((account) => <tr key={account.id}>
          <td><strong>{account.accountNumber}</strong><small className="table-sub mono">{account.id.slice(0, 8)}</small></td>
          <td>{account.owner?.fullName || 'System account'}<small className="table-sub">{account.owner?.email || 'Not customer-owned'}</small></td>
          <td>{account.kind}</td><td><Money minor={account.balanceMinor} currency={account.currency} /></td><td><StatusBadge value={account.status} /></td>
          <td className="table-actions">{account.kind === 'CUSTOMER' && account.status === 'ACTIVE' && <>
            <button className="button button-quiet button-small" onClick={() => { setConfirm({ type: 'fund', account }); setFundAttempt(null); setFundAmount(''); }}>Fund</button>
            <button className="button button-quiet button-small" onClick={() => setConfirm({ type: 'status', account, status: 'FROZEN' })}>Freeze</button>
            <button className="button button-danger-quiet button-small" onClick={() => setConfirm({ type: 'status', account, status: 'CLOSED' })}>Close</button>
          </>}{account.kind === 'CUSTOMER' && account.status === 'FROZEN' && <>
            <button className="button button-quiet button-small" onClick={() => setConfirm({ type: 'status', account, status: 'ACTIVE' })}>Unfreeze</button>
            <button className="button button-danger-quiet button-small" onClick={() => setConfirm({ type: 'status', account, status: 'CLOSED' })}>Close</button>
          </>}</td>
        </tr>)}</tbody></table></div> : <EmptyState title="No accounts found">No accounts match the selected filters.</EmptyState>}
        {result && <Pagination {...result.pagination} onPage={setPage} />}
      </section>
      {confirm?.type === 'status' && <ConfirmDialog title="Change account status?" message={`Change ${confirm.account.accountNumber} to ${confirm.status}? This does not change the account balance or kind.`} confirmLabel={`Set ${confirm.status.toLowerCase()}`} danger={confirm.status === 'CLOSED'} busy={busy} onCancel={() => setConfirm(null)} onConfirm={changeStatus} />}
      {confirm?.type === 'fund' && <div className="dialog-backdrop"><section className="dialog" role="dialog" aria-modal="true" aria-labelledby="fund-title"><h2 id="fund-title">Fund customer account</h2><p>Funding will debit the configured SYSTEM account and credit {confirm.account.accountNumber} as one ledger transaction.</p><Alert>{error}</Alert><Field label="Amount (INR)" type="text" inputMode="decimal" autoComplete="off" value={fundAmount} onChange={(event) => { setFundAmount(event.target.value); setNotice(''); }} placeholder="0.00" /><div className="dialog-actions"><button className="button button-quiet" onClick={() => { setConfirm(null); setFundAttempt(null); }} disabled={busy}>Cancel</button><button className="button button-primary" onClick={() => fundAccount(confirm.account)} disabled={busy}>{busy ? 'Posting…' : fundAttempt ? 'Retry funding' : 'Confirm funding'}</button></div></section></div>}
    </>
  );
}

function LedgerVerification() {
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function verify() {
    setBusy(true);
    setError('');
    try {
      setResult(await api.post('/admin/ledger/verify', {}));
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageTitle eyebrow="INTEGRITY CONTROL" title="Ledger verification" description="Compare each cached account balance with its authoritative ledger total. This check never repairs data." />
      <section className="panel verify-panel">
        <span className="feature-icon feature-icon-teal"><Activity size={20} /></span>
        <h2>Run a balance consistency check</h2>
        <p className="muted">The backend recalculates ledger balances using integer minor units and reports any mismatch for investigation.</p>
        <button className="button button-primary" onClick={verify} disabled={busy}>{busy ? 'Checking ledger…' : 'Run verification'} <RefreshCw size={16} /></button>
        <Alert>{error}</Alert>
      </section>
      {result && <section className="panel verification-result">
        <div className="section-heading"><div><p className="eyebrow">RESULT · {formatDate(result.checkedAt, { time: true })}</p><h2>{result.consistent ? 'All checked balances are consistent' : 'Balance discrepancies found'}</h2></div><StatusBadge value={result.consistent ? 'CONSISTENT' : 'DISCREPANCY'} /></div>
        <div className="verification-metrics"><Detail label="Accounts checked" value={result.checkedAccountCount} /><Detail label="Discrepancies" value={result.discrepancyCount} /></div>
        {result.discrepancies?.length ? <div className="table-scroll"><table><thead><tr><th>Account ID</th><th>Kind</th><th>Ledger total</th><th>Cached balance</th></tr></thead><tbody>{result.discrepancies.map((item) => <tr key={item.accountId}><td className="mono">{item.accountId}</td><td>{item.kind}</td><td><Money minor={item.ledgerBalanceMinor} /></td><td><Money minor={item.cachedBalanceMinor} /></td></tr>)}</tbody></table></div> : <div className="callout callout-success"><ShieldCheck size={18} /> No discrepancies were reported. No balances were changed.</div>}
      </section>}
    </>
  );
}

function AuditLog() {
  const [page, setPage] = useState(1);
  const [outcome, setOutcome] = useState('');
  const [targetType, setTargetType] = useState('');
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ page: String(page), limit: '20' });
      if (outcome) params.set('outcome', outcome);
      if (targetType) params.set('targetType', targetType);
      setResult(await api.get(`/admin/audit?${params}`));
    } catch (requestError) {
      setError(displayError(requestError));
    } finally {
      setLoading(false);
    }
  }, [page, outcome, targetType]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <PageTitle eyebrow="ACCOUNTABILITY" title="Audit trail" description="Paginated security and administrative events. Sensitive request contents are not displayed." action={<button className="button button-quiet" onClick={load}><RefreshCw size={16} /> Refresh</button>} />
      <Alert>{error}</Alert>
      <section className="panel">
        <div className="toolbar filter-toolbar">
          <SelectField label="Outcome" value={outcome} onChange={(event) => { setOutcome(event.target.value); setPage(1); }}><option value="">All outcomes</option><option value="SUCCESS">Success</option><option value="DENIED">Denied</option><option value="FAILURE">Failure</option></SelectField>
          <Field label="Target type" maxLength={64} value={targetType} onChange={(event) => { setTargetType(event.target.value); setPage(1); }} placeholder="e.g. User" />
        </div>
        {loading ? <Loading /> : error && !result ? <RetryButton onRetry={load} /> : result?.auditLogs.length ? <div className="table-scroll"><table><thead><tr><th>Event</th><th>Target</th><th>Outcome</th><th>Details</th><th>Time</th></tr></thead><tbody>{result.auditLogs.map((log) => <tr key={log.id}>
          <td><strong>{log.action}</strong><small className="table-sub">Actor {log.actorId || 'system'}</small></td><td>{log.targetType || '—'}<small className="table-sub mono">{log.targetId || '—'}</small></td>
          <td><StatusBadge value={log.outcome} /></td><td className="audit-metadata">{safeMetadata(log.metadata)}</td><td>{formatDate(log.createdAt, { time: true })}</td>
        </tr>)}</tbody></table></div> : <EmptyState title="No audit events found">No audit records match the selected filters.</EmptyState>}
        {result && <Pagination {...result.pagination} onPage={setPage} />}
      </section>
    </>
  );
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return '—';
  return Object.entries(metadata)
    .filter(([key, value]) => /reasonCode/iu.test(key) && typeof value === 'string')
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ') || '—';
}

export default App;
