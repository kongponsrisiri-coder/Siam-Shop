import React from 'react';

// Last line of defence (HOTFIX 0.1.2): a render error anywhere in the app used
// to leave a BLANK window — the worst thing a shop owner can see. Show what
// broke and a Reload button instead, and log it so the desktop --enable-logging
// capture has the stack.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error('[siamshop] render error:', error, info?.componentStack);
  }
  render() {
    if (!this.state.error) return this.props.children;
    const err = this.state.error;
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '40px auto' }}>
        <h2 style={{ marginTop: 0 }}>Something went wrong on this screen</h2>
        <p>The till hit an error while drawing the page. Reload to try again. If it keeps happening, send the text below to support.</p>
        <pre style={{ background: '#f4f4f4', padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 12 }}>
          {String(err?.message || err)}{'\n'}{String(err?.stack || '').split('\n').slice(1, 6).join('\n')}
        </pre>
        <button type="button" onClick={() => window.location.reload()} style={{ padding: '10px 18px', fontSize: 16, cursor: 'pointer' }}>Reload</button>
        <button type="button" onClick={() => { window.location.hash = '#/'; window.location.reload(); }} style={{ padding: '10px 18px', fontSize: 16, cursor: 'pointer', marginLeft: 8 }}>Go to start</button>
      </div>
    );
  }
}
