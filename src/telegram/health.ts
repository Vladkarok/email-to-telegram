let botHealthy = false;

export function markBotHealthy(): void {
  botHealthy = true;
}

export function markBotUnhealthy(): void {
  botHealthy = false;
}

export function isBotHealthy(): boolean {
  return botHealthy;
}
