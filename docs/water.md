# Water and vehicle handling

The immutable island still ends at `LIMIT = 816`. The playable world extends to `WORLD_LIMIT = 1072`. The square ring outside land has a flat authoritative water height of `-1.1`; render waves do not change collision or swimming height.

`shared/water.ts` owns the water predicate, floor height, and world boundaries. Watercraft collide with the island using their full rotated hull, then clamp their projected hull extents to the outer boundary. The server, prediction, and render corrections apply the same constraints, including after dynamic pair contacts. Cars retain the original land boundary. Characters and aircraft can travel offshore.

Swimming speed is 2.8 m/s. Characters step from swimming height onto the shallow quay edge when crossing onto land. Watercraft boarding accepts swimmers and nearby shore characters. Exits set the actual land or water floor and do not deploy parachutes. Drivers alone control propulsion; passengers retain independent exit behavior. Unoccupied craft coast with water drag and cannot accelerate from input.

The shared catalog contains two models for boats, jet skis, speedboats, helicopters, and planes. `shared/physics/watercraft.ts` uses model acceleration, reverse thrust, drag, lateral grip, turn response, braking, and speed limits. Helicopters use model horizontal, yaw, climb/descent, and vertical response parameters. E/Q controls altitude, Space brakes horizontal movement, and automatic roof clearance remains active. Plane models set thrust, stall speed, drag, braking, taxi/air turn response, climb/descent, vertical response, and ceiling. E/Q climbs or descends only above stall airspeed. Abandoned aircraft fall and crash at the actual land, roof, or water floor; the server alone applies ditching damage.

Each watercraft model has an idle spawn on the west coast near `x = -823`, with `z` positions from -48 to 32. Six AI watercraft follow separate clockwise or counterclockwise rectangular offshore routes using the same solver. They slow for turns and nearby hulls. Taking the driver seat removes the cruising route. Watercraft spawn placement derives from fixed coast coordinates, not a regenerated city.

The city streaming manifest keeps its original land boundary. Pure-water neighborhoods request no chunks and are immediately ready; shore neighborhoods still require land geometry.

Behavior coverage is in `tests/water.test.ts` and `tests/aircraft-handling.test.ts`: saved-map model placement and immutability, hull corners, final-contact bounds, authority/prediction agreement, variant differences, swimmer boarding and shore exits, three-minute AI cruising, flight controls, stalls, and ditching. These tests do not replace browser review of water animation, craft art, or subjective handling.
