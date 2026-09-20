import { StrictMode, Component, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'
import '@fontsource/noto-sans-arabic/arabic-400.css'
import '@fontsource/noto-sans-arabic/arabic-500.css'
import '@fontsource/noto-sans-arabic/arabic-600.css'
import '@fontsource/noto-sans-arabic/arabic-700.css'
import App from './App.tsx'
import { I18nProvider } from './i18n.tsx'

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 40, color: '#ef4444', background: '#111', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          <h2>App Error</h2>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <App />
      </I18nProvider>
    </ErrorBoundary>
  </StrictMode>,
)
