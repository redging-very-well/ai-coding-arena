export default class Clumsy {
  constructor() {
    this.name = 'Clumsy';
    this.type = 'soldier';
    this.maxHealth = this.config.hp; // this.config is undefined
  }
}
