/** Un billet qui ferait dépasser le plafond est refusé en entier (comme sur le serveur). */
export const canInsert = (balanceAr: number, bill: number, walletCapAr: number): boolean => balanceAr + bill <= walletCapAr;
