export function ErrorBanner({ message, onRetry, onClose }) {
  if (!message) return null;
  return (
    <div className="error-banner" role="alert">
      <span className="error-banner-icon" aria-hidden="true">!</span>
      <span className="error-banner-text">{message}</span>
      {onRetry ? (
        <button type="button" className="error-banner-retry" onClick={onRetry}>
          重试
        </button>
      ) : null}
      <button type="button" className="error-banner-close" aria-label="关闭错误提示" onClick={onClose}>
        ×
      </button>
    </div>
  );
}

export function LoadingBlock({ label = "正在加载…", lines = 3, compact = false }) {
  return (
    <div className={compact ? "loading-block compact" : "loading-block"} role="status" aria-live="polite">
      <div className="loading-label">
        <span className="spinner" aria-hidden="true" />
        <span>{label}</span>
      </div>
      <div className="skeleton-lines" aria-hidden="true">
        {Array.from({ length: lines }, (_, index) => (
          <span key={index} style={{ width: `${92 - index * 11}%` }} />
        ))}
      </div>
    </div>
  );
}

export function EmptyState({ title, description, actionLabel, actionHref, onAction }) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">＋</span>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {actionLabel && actionHref ? (
        <a className="primary empty-state-action" href={actionHref}>{actionLabel}</a>
      ) : actionLabel && onAction ? (
        <button className="primary empty-state-action" type="button" onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
