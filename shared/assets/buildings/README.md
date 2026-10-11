# Building placeholder assets

These twelve JSON recipes are the replaceable building asset catalog. The offline
city generator selects a recipe by district, fits it into a lot, chooses its
palette and height, and persists its stable `asset` ID plus dimensions and street
facing in `data/city.json`. Nothing generates a city in the browser.

- `glass-tower`: cool glass ribbons and floor bands
- `deco-tower`: warm vertical piers and layered crown trim
- `hotel`: pastel balconies and a ground-floor shop
- `apartments`: garden district balcony blocks
- `shop-house`: small pastel shops with striped awnings
- `market-hall`: broad, low commercial buildings
- `warehouse`: industrial windows and loading shutters
- `villa`: low garden homes
- `townhouse`: low Northwood housing
- `campus`: university and airport terminal buildings
- `civic-hall`: colonnaded campus landmarks
- `container`: collidable port cargo

`client/models/buildings/index.ts` turns these recipes into simple Babylon meshes.
That is the visual replacement point for future authored models. Keep stable IDs;
fit replacement models to the instance's `w`, `d`, `h`, and `facing` (0 = south,
1 = east, 2 = north, 3 = west). A model's origin is ground centre. Dimensions are
world metres, with Y up. Collision remains a solid rectangular server-owned
volume; a model requiring terraces, overhangs or enterable courtyards needs a
matching shared/server collision contract, not just a visual replacement.

Edit JSON height ranges, palettes, floor spacing or facade treatments here, then
run `bun run city:generate --seed 713` and restart the server. Register new recipe
files in `index.ts` and add district selection in `scripts/city-generator.ts`.
The generator composes ten districts over a 1.632 km square island. Roads are generated first, then recipes are placed along their frontage and in clear back lots. It leaves at least a metre beyond
the sidewalks, reserves parks and the runway, and keeps alleys between lots.
District geography stays fixed so landmarks and the navigation network remain
recognizable; seeds vary road bends, buildings, dimensions and colours.

The v3 artifact replaces v1/v2: regenerate old artifacts manually. Meshes are still
procedural placeholders, not GLB files. Ground remains flat; height variation is
architectural. Park fountains and shallow facade trim are decorative.
