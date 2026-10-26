// /play entry: Preact app for the players' laptops and tablets.

import { render } from 'preact';
import '../common/theme.css';
import './play.css';
import { ensureFonts } from '../common/ui.js';
import { App } from './components/App.js';
import { getStore } from './store.js';

const root = document.getElementById('app');
if (root) {
  root.textContent = '';
  render(<App />, root);
}
void ensureFonts();
void getStore().boot();
