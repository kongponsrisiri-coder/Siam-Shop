import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, HashRouter } from 'react-router-dom';
import App from './App.jsx';
import { CartProvider } from './cart.jsx';
import { LangProvider } from './lang.jsx';
import { isElectron } from './electron.js';
import ErrorBoundary from './ErrorBoundary.jsx';
import './styles.css';

// Desktop till loads the bundle from file:// (SIAMSHOP-ELECTRON-001), where
// path-based routing has nothing to route on — use the hash router there.
const Router = isElectron ? HashRouter : BrowserRouter;

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <Router>
        <LangProvider>
          <CartProvider>
            <App />
          </CartProvider>
        </LangProvider>
      </Router>
    </ErrorBoundary>
  </React.StrictMode>
);
