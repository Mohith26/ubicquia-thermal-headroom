# Thermal Headroom for UbiVu (concept)

**Live demo:** https://mohith26.github.io/ubicquia-thermal-headroom/

Unofficial concept by Mohith Gajjela. Not affiliated with Ubicquia. Synthetic data.

## What it is

UbiVu's transformer insights include "Overloaded Transformer: calculated kVA exceeding the rating for at least 1 hour" and "High Oil Temperature > 95 °C" (UbiVu User Manual, Appendix E). A kVA rating is a thermal rating in disguise: what actually wears a transformer out is winding hot-spot temperature, which depends on the load history, the ambient, the tank's thermal time constant and the sun on the tank. With distribution transformers on multi-year lead times, the useful question is not "was kVA above nameplate" but "is this unit aging faster than normal, and how much more load (EV chargers) can it take?"

Thermal Headroom is a new metric on the UbiVu **Activity** tab (next to Metrics Overview) that answers that per transformer from data the UbiGrid DTM+ already sends (secondary kVA, oil temperature) plus ambient:

1. **Identify each unit's thermal model** (IEEE C57.91 exponential top-oil model): time constant τ, loss ratio R, rated top-oil rise, sensor offset and a solar-gain term, fit to its own oil temperature.
2. **Calibrate the forecast error** with split conformal prediction on daily peak oil temperature, pooled across the fleet.
3. **Hot-spot and aging**: hot-spot = top oil + 25 °C · K^1.6, aging acceleration F_AA = exp(15000/383 - 15000/(θ_H + 273)), daily equivalent aging F_EQA.
4. **EV hosting**: Monte Carlo of added Level 2 chargers (7.2 kW, evening plug-ins, log-normal energy) on the hottest day of the record, with the conformal margin added; the largest count whose risk of exceeding 120 °C hot-spot or 1 day/day aging stays under the target.
5. **Verdict**: Replace (already over the limit on the design day), Monitor (room for at most one more charger), Defer (room for two or more).

## Result on the demo fleet (risk target 10%)

Computed by `node scripts/report.js` on 48 synthetic pole-mount transformers (25 to 75 kVA), 60 summer days at 30-minute resolution, Palm Beach-like weather:

- The kVA rule flags **35** transformers as overloaded.
- The thermal model says **19** of those need replacement, **12** are at their limit (monitor) and **4** can defer with room for **10** more chargers between them, so **16 of the 35 flagged units can stay in service**.
- Conformal margin on daily peak oil temperature: **+0.70 °C** from 720 calibration day-peaks; it held on **91.0%** of 480 held-out day-peaks (target 90%).
- Identification recovers the generator's hidden time constants to **0.06 h** on average and rated top-oil rise to **2.8 °C**.

## Tests

```
node --test test/thermal.test.js   # 9 tests
node scripts/report.js             # every number above
```

Tests cover F_AA reference points (1.0 at 110 °C, about 2.7 at 120 °C), the top-oil step response (63.2% at one time constant), exact parameter recovery on noiseless model data, the conformal order statistic and its coverage, the 1-hour kVA rule, EV session energy, monotone aging in added chargers (common random numbers), determinism of the committed data, and verdict/hosting consistency.

## Limitations (honest)

- Synthetic fleet. Loads, EV ownership, weather and true thermal parameters come from `scripts/gen-data.js`. The generator adds solar heating with daily cloud cover and sensor noise, which the fit only partly captures, but it is still the same model family, so real data will fit worse.
- The DTM+ oil sensor is treated as top-oil temperature. The rated hot-spot gradient (25 °C) is an assumption; it is not identifiable from oil temperature alone. A per-model nameplate value or a short heat-run would fix it.
- Loss ratio R is weakly identifiable (one unit sits at the grid edge of 10); the hot-spot forecast is much less sensitive to it than τ and the rated rise.
- 30-minute data; the winding time constant (minutes) is ignored. DTM+ reports every 2 minutes, which would allow it.
- The conformal margin is pooled across the fleet and assumes calibration and future days are exchangeable; a heat wave outside the calibration window can break that. Coverage is reported on held-out days so drift is visible.
- EV behaviour (7.2 kW, 85% daily use, evening arrivals) is an assumption; managed charging would raise hosting.

## Novelty note

UbiVu shows oil temperature and current charts (and has a transformer thermal graph endpoint) and flags overloads by kVA and oil temperature thresholds; I found no hot-spot, loss-of-life or EV-hosting analysis in the UbiVu manual, product pages or the public app bundle. Other monitor vendors do ship loss-of-life (for example Franklin Grid's DTM and Oktogrid's dynamic thermal rating). The new parts here are per-unit model identification from the monitor's own oil data (with a solar term), a calibrated forecast margin with reported held-out coverage, and EV hosting counts with a stated risk, used to re-sort UbiVu's existing "Overloaded" list into replace / monitor / defer.
