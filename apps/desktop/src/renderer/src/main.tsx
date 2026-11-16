import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
// The styles, in a fixed order: the tokens first, the accessibility rules last.
import './styles/tokens.css';
import './styles/base.css';
import './styles/controls.css';
import './styles/dialogs.css';
import './styles/layout.css';
import './styles/people.css';
import './styles/charts.css';
import './styles/gedcom.css';
import './styles/sources.css';
import './styles/records.css';
import './styles/media.css';
import './styles/places.css';
import './styles/packs.css';
import './styles/ai.css';
import './styles/a11y.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root element');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
