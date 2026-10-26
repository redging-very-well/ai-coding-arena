// Entry of /admin.

import { render } from 'preact';
import '../common/theme.css';
import './admin.css';
import { App } from './App.js';

render(<App />, document.getElementById('app')!);
