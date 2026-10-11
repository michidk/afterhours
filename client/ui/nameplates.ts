import { Matrix, Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { CityScene } from "../scene.ts";
import type { PlayerSummary } from "../../shared/protocol.ts";
import type { Entity } from "../../shared/world.ts";

export class Nameplates {
  private labels = new Map<string, HTMLDivElement>();
  private players: PlayerSummary[] = [];
  private layer = document.createElement("div");
  constructor() {
    this.layer.className = "nameplates";
    this.layer.setAttribute("aria-hidden", "true");
    document.body.append(this.layer);
  }
  roster(players: PlayerSummary[]) {
    this.players = players;
  }
  update(host: CityScene, entities: Entity[], self?: string) {
    const visible = new Set<string>();
    const width = host.engine.getRenderWidth(),
      height = host.engine.getRenderHeight();
    const viewport = host.camera.viewport.toGlobal(width, height);
    for (const player of this.players) {
      if (player.id === self) continue;
      const actor = entities.find((e) => e.id === player.id);
      if (!actor || actor.health <= 0) continue;
      const body = entities.find((e) => e.id === actor.vehicle) || actor;
      if (Math.hypot(body.x - host.target.x, body.z - host.target.z) >= 95) continue;
      const point = Vector3.Project(
        new Vector3(body.x, body.y + (actor.vehicle ? 3.2 : 2.7), body.z),
        Matrix.Identity(),
        host.scene.getTransformMatrix(),
        viewport,
      );
      if (
        point.z < 0 ||
        point.z > 1 ||
        point.x < 0 ||
        point.x > width ||
        point.y < 0 ||
        point.y > height
      )
        continue;
      let label = this.labels.get(player.id);
      if (!label) {
        label = document.createElement("div");
        label.className = "nameplate";
        label.dataset.playerId = player.id;
        this.layer.append(label);
        this.labels.set(player.id, label);
      }
      label.textContent = player.name;
      label.style.left = `${(point.x / width) * 100}%`;
      label.style.top = `${(point.y / height) * 100}%`;
      label.style.marginTop = `${actor.vehicle ? -(actor.seat || 0) * 19 : 0}px`;
      visible.add(player.id);
    }
    for (const [id, label] of this.labels)
      if (!visible.has(id)) {
        label.remove();
        this.labels.delete(id);
      }
  }
  clear() {
    this.players = [];
    this.layer.replaceChildren();
    this.labels.clear();
  }
}
