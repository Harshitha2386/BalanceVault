import { Link, NavLink } from 'react-router-dom';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, Landmark } from 'lucide-react';
import { formatMinorCurrency } from './money.js';

function Brand({ compact = false }) {
  return (
    <Link className={`brand ${compact ? 'brand-compact' : ''}`} to="/">
      <span className="brand-mark"><Landmark size={21} strokeWidth={2.2} /></span>
      <span>Balance<span className="brand-light">Vault</span></span>
    </Link>
  );
}

function PageTitle({ eyebrow, title, description, action }) {
  return (
    <div className="page-title">
      <div>
        {eyebrow && <p className="eyebrow">{eyebrow}</p>}
        <h1>{title}</h1>
        {description && <p className="muted page-description">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function Alert({ children, tone = 'error' }) {
  if (!children) return null;
  return <div className={`alert alert-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>{children}</div>;
}

function Loading({ label = 'Loading your information' }) {
  return <div className="loading" role="status"><span className="spinner" />{label}</div>;
}

function EmptyState({ title, children }) {
  return <div className="empty-state"><span className="empty-icon"><Landmark size={20} /></span><strong>{title}</strong><p>{children}</p></div>;
}

function Pagination({ page, limit, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / limit));
  return (
    <div className="pagination">
      <span className="muted">{total.toLocaleString('en-IN')} records · page {page} of {pages}</span>
      <div className="pagination-actions">
        <button className="button button-quiet button-small" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page">
          <ChevronLeft size={16} /> Previous
        </button>
        <button className="button button-quiet button-small" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Next page">
          Next <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ value }) {
  const normalized = String(value || '').toLowerCase();
  return <span className={`status-badge status-${normalized}`}>{String(value || 'Unknown').replaceAll('_', ' ')}</span>;
}

function Money({ minor, currency = 'INR', className = '' }) {
  return <span className={className}>{formatMinorCurrency(minor, currency)}</span>;
}

function TransactionAmount({ entries }) {
  const entry = entries?.[0];
  if (!entry) return <span className="muted">—</span>;
  const debit = entry.direction === 'DEBIT';
  return (
    <span className={`transaction-amount ${debit ? 'amount-out' : 'amount-in'}`}>
      {debit ? <ArrowUpRight size={15} /> : <ArrowDownLeft size={15} />}
      <Money minor={entry.amountMinor} currency={entry.currency} />
    </span>
  );
}

function SidebarLink({ to, icon: Icon, children }) {
  return (
    <NavLink end={to === '/app' || to === '/admin'} className={({ isActive }) => `nav-link ${isActive ? 'nav-link-active' : ''}`} to={to}>
      <Icon size={18} strokeWidth={1.8} /><span>{children}</span>
    </NavLink>
  );
}

function Field({ label, hint, ...props }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
      {hint && <small>{hint}</small>}
    </label>
  );
}

function SelectField({ label, children, ...props }) {
  return <label className="field"><span>{label}</span><select {...props}>{children}</select></label>;
}

function ConfirmDialog({ title, message, confirmLabel = 'Confirm', danger = false, onCancel, onConfirm, busy = false }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dialog-title">
        <h2 id="dialog-title">{title}</h2>
        <p>{message}</p>
        <div className="dialog-actions">
          <button className="button button-quiet" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className={`button ${danger ? 'button-danger' : 'button-primary'}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'Please wait…' : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export {
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
};
