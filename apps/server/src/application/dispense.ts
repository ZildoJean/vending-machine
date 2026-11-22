import type { DispenseOutcome, DispenseRequest, Dispenser, Logger } from './ports';

/**
 * Appelle le matériel avec un délai maximal. Ne lève jamais :
 *  - exception du matériel  -> unité non délivrée (ERROR) ;
 *  - dépassement du délai   -> unité non délivrée (TIMEOUT). Si le matériel répond PLUS TARD
 *    qu'il a livré, c'est journalisé en erreur (l'unité aura été remboursée : à investiguer).
 */
export async function dispenseWithTimeout(
  dispenser: Dispenser,
  req: DispenseRequest,
  timeoutMs: number,
  logger: Logger,
): Promise<DispenseOutcome> {
  const hardware: Promise<DispenseOutcome> = Promise.resolve()
    .then(() => dispenser.dispense(req))
    .catch((e: unknown): DispenseOutcome => ({
      delivered: false,
      reason: `ERROR: ${e instanceof Error ? e.message : String(e)}`,
    }));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'TIMEOUT'>((resolve) => {
    timer = setTimeout(() => resolve('TIMEOUT'), timeoutMs);
  });
  const winner = await Promise.race([hardware, timeout]);
  if (timer !== undefined) clearTimeout(timer);

  if (winner === 'TIMEOUT') {
    void hardware.then((late) => {
      if (late.delivered) {
        logger.error('Livraison tardive après délai : unité déjà considérée non délivrée', { ...req });
      }
    });
    return { delivered: false, reason: 'TIMEOUT' };
  }
  return winner;
}
