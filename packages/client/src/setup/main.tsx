// Entry of /setup (plan §11 "/setup page"): open to facilitators.

import { render } from 'preact';
import '../common/theme.css';
import '../admin/admin.css';
import './setup.css';
import { SetupPage } from './SetupPage.js';

render(<SetupPage />, document.getElementById('app')!);
