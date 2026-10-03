import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SprintProvider } from '@westonkd/sprint';
import { App } from './App';
import './base.css';
import '@westonkd/sprint/styles.css';
import './theme.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SprintProvider label="Loupe">
      <App />
    </SprintProvider>
  </StrictMode>,
);
