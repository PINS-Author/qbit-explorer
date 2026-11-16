import { Injectable } from '@angular/core';
import { catchError, forkJoin, map, Observable, of, switchMap, tap } from 'rxjs';
import { Inscription } from '@app/shared/ord/inscription.utils';
import { Transaction } from '@interfaces/electrs.interface';
import { getNextInscriptionMark, getNextPinsInscriptionMark, hasUnknownEvenTag, hexToBytes, extractInscriptionData } from '@app/shared/ord/inscription.utils';
import { decipherRunestone, Runestone, Etching } from '@app/shared/ord/rune.utils';
import { ElectrsApiService } from '@app/services/electrs-api.service';


@Injectable({
  providedIn: 'root'
})
export class OrdApiService {

  constructor(
    private electrsApiService: ElectrsApiService,
  ) { }

  decodeRunestone$(tx: Transaction): Observable<{ runestone: Runestone, runeInfo: { [id: string]: { etching: Etching; txid: string; } } }> {
    const runestone = decipherRunestone(tx);
    const runeInfo: { [id: string]: { etching: Etching; txid: string; } } = {};

    if (runestone) {
      const runesToFetch: Set<string> = new Set();

      if (runestone.mint) {
        runesToFetch.add(runestone.mint.toString());
      }

      if (runestone.edicts.length) {
        runestone.edicts.forEach(edict => {
          runesToFetch.add(edict.id.toString());
        });
      }

      if (runesToFetch.size) {
        const runeEtchingObservables = Array.from(runesToFetch).map(runeId => this.getEtchingFromRuneId$(runeId));

        return forkJoin(runeEtchingObservables).pipe(
          map((etchings) => {
            etchings.forEach((el) => {
              if (el) {
                runeInfo[el.runeId] = { etching: el.etching, txid: el.txid };
              }
            });
            return { runestone: runestone, runeInfo };
          })
        );
      }
      return of({ runestone: runestone, runeInfo });
    } else {
      return of({ runestone: null, runeInfo: {} });
    }
  }

  // Get etching from runeId by looking up the transaction that etched the rune
  // qbit has no hardcoded UNCOMMON•GOODS at 1:0, so every qrune ID resolves through its etching
  getEtchingFromRuneId$(runeId: string): Observable<{ runeId: string; etching: Etching; txid: string; }> {
    const [blockNumber, txIndex] = runeId.split(':');
    return this.electrsApiService.getBlockHashFromHeight$(parseInt(blockNumber)).pipe(
      switchMap(blockHash => this.electrsApiService.getBlockTxId$(blockHash, parseInt(txIndex))),
      switchMap(txId => this.electrsApiService.getTransaction$(txId)),
      switchMap(tx => {
        const runestone = decipherRunestone(tx);
        if (runestone) {
          const etching = runestone.etching;
          if (etching) {
            return of({ runeId, etching, txid: tx.txid });
          }
        }
        return of(null);
      }),
      catchError(() => of(null))
    );
  }

  decodeInscriptions(witness: string): Inscription[] | null {

    const inscriptions: Inscription[] = [];
    const raw = hexToBytes(witness);
    let startPosition = 0;

    while (true) {
      const pointer = getNextInscriptionMark(raw, startPosition);
      if (pointer === -1) {break;}

      const inscription = extractInscriptionData(raw, pointer);
      if (inscription) {
        inscriptions.push(inscription);
      }

      startPosition = pointer;
    }

    return inscriptions;
  }

  /**
   * Reads the P2MR Inscriptions (PINS-1) of a leaf script, in order. Same envelope fields as decodeInscriptions reads;
   * only the marker `pins` is looked for. A P2MR Inscription with an unknown even tag is returned as opaque: its size
   * only, nothing of its content (PINS-1 section 5.4).
   */
  decodePinsInscriptions(script: string): Inscription[] {
    const inscriptions: Inscription[] = [];
    const raw = hexToBytes(script);
    let startPosition = 0;

    while (true) {
      const pointer = getNextPinsInscriptionMark(raw, startPosition);
      if (pointer === -1) {break;}

      const inscription = extractInscriptionData(raw, pointer);
      if (inscription) {
        inscriptions.push(hasUnknownEvenTag(raw, pointer)
          ? { opaque: true, content_type_str: 'undefined', body: new Uint8Array(), is_cropped: false, body_length: inscription.body_length, delegate_txid: null }
          : inscription);
      }

      startPosition = pointer;
    }

    return inscriptions;
  }
}
