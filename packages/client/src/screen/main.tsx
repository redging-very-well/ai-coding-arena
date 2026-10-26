// /screen entry: the projector view.

import { render } from 'preact';
import '../common/theme.css';
import './screen.css';
import { ensureFonts } from '../common/ui.js';
import { App } from './App.js';

void ensureFonts();
render(<App />, document.getElementById('app')!);
