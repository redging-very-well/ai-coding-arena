export default class DynamicImporter {
  constructor() { this.name = 'Dynamic'; }
  update() {
    import('fs').then(() => {});
    return { action: 'idle' };
  }
}
