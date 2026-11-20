/** Port : la seule source de temps de l'application. Le domaine, lui, reçoit `now` en paramètre. */
export interface Clock {
  /** Millisecondes depuis l'epoch. */
  now(): number;
}
