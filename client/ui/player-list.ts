import type { PlayerSummary } from "../../shared/protocol.ts";

export class PlayerList {
  constructor(
    private list: HTMLUListElement,
    private count: HTMLElement,
  ) {}
  update(players: PlayerSummary[], selfId?: string) {
    this.count.textContent = String(players.length);
    const rows = [...players]
      .sort(
        (a, b) =>
          Number(b.id === selfId) - Number(a.id === selfId) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )
      .map((player) => {
        const row = document.createElement("li"),
          marker = document.createElement("span"),
          name = document.createElement("span");
        row.dataset.playerId = player.id;
        marker.className = "player-colour";
        marker.style.backgroundColor = /^#[0-9a-f]{6}$/i.test(player.color)
          ? player.color
          : "#b8c8be";
        marker.setAttribute("aria-hidden", "true");
        name.className = "player-name";
        name.textContent = player.name;
        row.append(marker, name);
        if (player.id === selfId) {
          row.classList.add("self");
          const badge = document.createElement("small");
          badge.textContent = "YOU";
          row.append(badge);
        }
        return row;
      });
    this.list.replaceChildren(...rows);
  }
  clear(message: string) {
    this.count.textContent = "—";
    const row = document.createElement("li");
    row.className = "roster-status";
    row.textContent = message;
    this.list.replaceChildren(row);
  }
}
