// Basic Wall: the starter wall template (Pixel Clash).
//
// A wall is a solid 40x40 block that fills its cell. It can't move or attack and runs no code,
// it just stops everybody (your own units too, so leave a gap!) until it is smashed.
// Walls don't count as survivors at the end: you still need fighters.
//
// Cost = 20 + maxHealth*0.0375 * (1 + (maxHealth/12000)^2)
//      = 20 + 120 * 1.0711 = 148.53  ->  $149   (walls never cost more for extra copies)
//
// No imports, no timers, no network, no async.

export default class BasicWall {
  constructor() {
    this.name = 'Basic Wall';
    this.type = 'wall';         // a building: never moves, never attacks
    this.maxHealth = 3200;      // 400-12000
    this.color = '#8A8F98';     // "#RRGGBB": the block's colour
  }

  // No update(): walls don't think. The sprite textures the sides of the block:
  // stone bricks with dark mortar lines, every other row shifted by half a brick.
  sprite() {
    return {
      grid: 16,
      palette: { o: '#3A3D44', l: '#B4BAC4', g: '#8A8F98', d: '#666B74' },
      frames: {
        idle: [[
          'oooooooooooooooo',
          'lllllldolllllldo',
          'lgggggdolgggggdo',
          'lddddddolddddddo',
          'oooooooooooooooo',
          'lldolllllldollll',
          'ggdolgggggdolggg',
          'dddolddddddolddd',
          'oooooooooooooooo',
          'lllllldolllllldo',
          'lgggggdolgggggdo',
          'lddddddolddddddo',
          'oooooooooooooooo',
          'lldolllllldollll',
          'ggdolgggggdolggg',
          'dddolddddddolddd',
        ]],
      },
    };
  }
}
