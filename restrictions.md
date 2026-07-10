# Mitigation Restrictions vs Real World Traffic

The restrictions that our mitigation places of traffic depend on:
- The amount of liquidity in a channel (`max_htlc_value_in_flight_msat`)
- The amount of slots in a channel (`max_accepted_htlcs`)

To a routing node:
- These values are not observable.
- We know `max_htlc_value_in_flight_msat` is at least `htlc_maximum_msat`.

Based on today's defaults we can assume:
- `max_htlc_value_in_flight_msat` = size of channel (LND's default)
- `max_accepted_htlcs` = 483 or 114 (LND's default, different channel types)

## Proposal Restrictions

Our currently proposed resource breakdown is as follows:

General Bucket: 40%
Congestion Bucket: 20%
Protected Bucket: 40%

We limit the slots in our general bucket that an outgoing channel may
occupy, so that an attacker is forced to open multiple channels to fully
saturate its (otherwise unrestricted resources).

The slots per bucket, and channel count required to saturate the
*general* bucket are provided below for different channel types (483 and
114) and commonly configured `max_accepted_htlcs` (50):

| Channel Slots | General Bucket | Congestion Bucket | Protected Bucket | Channels to Saturate |
| ------------: | -------------: | ----------------: | ---------------: | -------------------: |
|           483 |            193 |                96 |              194 |                   50 |
|           114 |             45 |                22 |               47 |                   38 |
|            50 |             20 |                10 |               20 |                   13 |

Note: these numbers come from the mainnet graph, filtering out nodes
with a single channel as they're likely to be non-forwarding nodes*.

### General Bucket Restrictions

We restrict our general slots to:
`max(5, general bucket slot total*5/100)`

And liquidity per slot:
`max_htlc_value_in_flight_msat * 0.4 / max_accepted_htlcs * 0.4`

| Channel Slots | General Bucket Slots | Liquidity per Slot                       | Largest HTLC                             |
| ------------: | -------------------: | ---------------------------------------- | ---------------------------------------- |
|           483 |                    9 | 0.21% of `max_htlc_value_in_flight_msat` | 1.87% of `max_htlc_value_in_flight_msat` |
|           114 |                    5 | 0.87% of `max_htlc_value_in_flight_msat` | 4.35% of `max_htlc_value_in_flight_msat` |
|            50 |                    5 | 2% of `max_htlc_value_in_flight_msat`    | 10% of `max_htlc_value_in_flight_msat`   |

Based on River's reports over the years, we can reasonably expect:
- Median payment amount of $10-20
- Mean payment amount around $200


Share of network edges that support a single HTLC of $X in general:

| Threshold | 483 @ $50k | 483 @ $75k | 483 @ $100k | 114 @ $50k | 114 @ $75k | 114 @ $100k | 50 @ $50k | 50 @ $75k | 50 @ $100k |
| :-------: | ---------: | ---------: | ----------: | ---------: | ---------: | ----------: | --------: | --------: | ---------: |
|    ≥ $1   |      90.7% |      94.6% |       95.1% |      96.1% |      96.6% |       97.2% |     97.5% |     98.6% |      98.9% |
|    ≥ $5   |      77.5% |      83.7% |       85.6% |      87.2% |      89.7% |       90.6% |     91.4% |     94.7% |      95.3% |
|   ≥ $10   |      62.8% |      76.1% |       77.5% |      82.2% |      84.2% |       87.2% |     88.1% |     90.2% |      91.4% |
|   ≥ $25   |      46.0% |      58.2% |       61.1% |      62.1% |      75.8% |       77.3% |     78.3% |     84.1% |      86.2% |
|   ≥ $50   |      25.8% |      41.0% |       46.0% |      48.6% |      59.2% |       62.1% |     64.5% |     76.5% |      78.3% |
|   ≥ $100  |      12.3% |      22.9% |       25.8% |      36.2% |      41.9% |       48.6% |     50.6% |     61.1% |      64.5% |
|   ≥ $250  |       4.1% |       7.1% |       11.1% |      11.9% |      22.4% |       25.4% |     27.5% |     41.5% |      46.8% |
|   ≥ $500  |       2.3% |       3.6% |        4.1% |       4.9% |       9.6% |       11.9% |     13.3% |     23.6% |      27.5% |

With this count, an adversary would still need to open up 13 channels
in expectation to have a 95% chance of occupying all slots.

### Congestion Bucket Size

If the general bucket is saturated, we allow each downstream channel
access to one slot in the congestion bucket at a time.

Liquidity restriction:
`max_htlc_value_in_flight_msat * 0.2 / max_accepted_htlcs * 0.2`

So, similar to our general bucket we allow HTLCs of 0.21% and 0.87%
of our `max_htlc_value_in_flight_msat` for 483 and 114 slot channels
respectively.

Share of network edges that support a single HTLC of $X in congestion:
(note that this is the same as a single slot's worth of liquidity in general):

| Threshold | 483 @ $50k | 483 @ $75k | 483 @ $100k | 114 @ $50k | 114 @ $75k | 114 @ $100k | 50 @ $50k | 50 @ $75k | 50 @ $100k |
| :-------: | ---------: | ---------: | ----------: | ---------: | ---------: | ----------: | --------: | --------: | ---------: |
|    ≥ $1   |      74.2% |      76.7% |       82.0% |      87.2% |      89.7% |       90.6% |     90.8% |     94.7% |      95.1% |
|    ≥ $5   |      36.0% |      41.6% |       48.4% |      62.1% |      75.8% |       77.3% |     78.3% |     84.1% |      86.2% |
|   ≥ $10   |      20.1% |      23.7% |       36.0% |      48.6% |      59.2% |       62.1% |     64.5% |     76.5% |      78.3% |
|   ≥ $25   |       4.8% |       9.0% |       11.4% |      25.4% |      40.7% |       45.7% |     46.8% |     58.8% |      61.4% |
|   ≥ $50   |       3.2% |       3.6% |        4.8% |      11.9% |      22.4% |       25.4% |     27.5% |     41.5% |      46.8% |
|   ≥ $100  |       1.6% |       2.1% |        3.2% |       4.9% |       9.6% |       11.9% |     13.3% |     23.6% |      27.5% |
|   ≥ $250  |       0.4% |       0.7% |        0.8% |       2.2% |       3.5% |        4.1% |      4.3% |      7.5% |      11.3% |
|   ≥ $500  |       0.2% |       0.3% |        0.4% |       0.8% |       2.0% |        2.2% |      2.4% |      3.6% |       4.3% |

----

\* We do not expect LSPs/services that have private channels to serve
  clients to have a single public channel to the network, so we can
  rule out single channel nodes as forwarders with confidence.
