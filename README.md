# Game Girl

A retro handheld game player for your phone. It plays Game Boy and Game Boy Color games, and comes with 15 free homebrew games built in.

- Touch controls with a sliding D-pad, A/B, Start and Select, plus vibration on each press
- Works with a Bluetooth or USB controller, and with a keyboard (arrows, X, Z, Enter, Shift)
- Saves progress from each game's own save option automatically, plus Quick save and Quick load
- Install it on your phone's home screen and it works offline

## How to play

Open the site on your phone, tap **Start** (or the menu button at the top right), and pick a game under **Free games**. You can also add your own `.gb`, `.gbc` or `.zip` game files with **Add game**.

To install it on Android: open the site in Chrome, tap the ⋮ menu, then **Add to Home screen** (or **Install app**).

Your game list and saves are stored on your own device only.

## Free games included

All of these were released by their authors under open licences, and come from [Homebrew Hub](https://hh.gbdev.io). Full source code for each is linked from its Homebrew Hub page.

| Game | Type | Author | Licence | Source |
|---|---|---|---|---|
| Tobu Tobu Girl Deluxe | Action | Tangram Games | MIT | [Homebrew Hub](https://hh.gbdev.io/game/tobutobugirldeluxe) |
| uCity | Simulation | AntonioND | GPL-3.0-or-later | [Homebrew Hub](https://hh.gbdev.io/game/ucity) |
| Shock Lobster | Action | tbsp | Zlib | [Homebrew Hub](https://hh.gbdev.io/game/shock-lobster) |
| Renegade Rush | Racing | quinnp | MIT | [Homebrew Hub](https://hh.gbdev.io/game/renegade-rush) |
| 2048 | Puzzle | Sanqui | Zlib | [Homebrew Hub](https://hh.gbdev.io/game/2048gb) |
| GB-Wordyl | Word | bbbbbr | GPL-3.0 | [Homebrew Hub](https://hh.gbdev.io/game/gb-wordyl) |
| Petris | Puzzle | bbbbbr | CC-BY-NC-SA | [Homebrew Hub](https://hh.gbdev.io/game/petris) |
| Aevilia | Adventure | ISSOtm, Kai, Parzival, Charmy | Apache-2.0 | [Homebrew Hub](https://hh.gbdev.io/game/aevilia) |
| Tuff | Platform | BonsaiDen | MIT | [Homebrew Hub](https://hh.gbdev.io/game/tuff) |
| Rex Runner | Action | The Void | MIT | [Homebrew Hub](https://hh.gbdev.io/game/rex-runner-gb) |
| Flooder | Puzzle | Oliver Balfour | MIT | [Homebrew Hub](https://hh.gbdev.io/game/flooder) |
| Big2Small | Puzzle | mdsteele | GPL-3.0-or-later | [Homebrew Hub](https://hh.gbdev.io/game/big2small) |
| Pelmanism | Cards | TeamKNOx | MIT | [Homebrew Hub](https://hh.gbdev.io/game/gbccardgame) |
| Max Pirate | Action | Lemmy Hawkins | MIT | [Homebrew Hub](https://hh.gbdev.io/game/maxpirate) |
| Snake | Classic | Yvar de Goffau | WTFPL-2.0 | [Homebrew Hub](https://hh.gbdev.io/game/snake) |

## Building

```
npm install
npm run dev      # local development
npm run build    # production build into dist/
```

Built with React and Vite. The emulator core is [WasmBoy](https://github.com/torch2424/wasmboy) by Aaron Turner, run directly in the page (`src/engine.js`): it uses the WebAssembly core where the browser allows it and the JavaScript core otherwise.

## Licence

GPL-3.0-or-later, the same as WasmBoy. See [LICENSE](LICENSE). Each included game keeps its own licence, listed above. Fonts: Press Start 2P, Silkscreen and Space Grotesk (SIL Open Font License).
