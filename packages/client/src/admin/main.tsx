// Entry of /admin (plan §12.3).

import { render } from 'preact';
import '../common/theme.css';
import './admin.css';
import { App } from './App.js';

render(<App />, document.getElementById('app')!);
