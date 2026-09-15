import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import type { Request, Response } from "express";
import { z } from "zod";

const BITVAVO_API = "https://api.bitvavo.com/v2";

type Candle = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type Trade = {
  id: string;
  timestamp: number;
  amount: number;
  price: number;
};

type OrderBookLevel = [
  string,
  string
];

type OrderBook = {
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
};

const INTERVAL_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "2h": 7_200_000,
  "4h": 14_400_000,
  "6h": 21_600_000,
  "8h": 28_800_000,
  "12h": 43_200_000,
  "1d": 86_400_000
};

async function bitvavo(path: string): Promise<any> {
  const response = await fetch(`${BITVAVO_API}${path}`, {
    headers: {
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Bitvavo HTTP ${response.status}: ${await response.text()}`
    );
  }

  return response.json();
}

function parseCandles(raw: any[]): Candle[] {
  return raw
    .map((c: any[]) => ({
      timestamp: Number(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5])
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function getClosedCandles(
  market: string,
  interval: string,
  count: number
): Promise<Candle[]> {
  const intervalMs = INTERVAL_MS[interval];

  if (!intervalMs) {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  const raw = await bitvavo(
    `/${encodeURIComponent(
      market
    )}/candles?interval=${encodeURIComponent(interval)}&limit=${Math.min(
      1440,
      count + 3
    )}`
  );

  const candles = parseCandles(raw);
  const now = Date.now();

  return candles
    .filter(c => c.timestamp + intervalMs <= now)
    .slice(-count);
}

/**
 * Obtiene todos los trades del intervalo indicado.
 *
 * Bitvavo devuelve los trades de más reciente a más antiguo.
 * Cuando se alcanza el límite de 1000 resultados, usamos tradeIdTo
 * para continuar hacia atrás.
 */
async function getTradesForWindow(
  market: string,
  start: number,
  end: number
): Promise<Trade[]> {
  const tradesById = new Map<string, Trade>();

  let tradeIdTo: string | undefined;

  while (true) {
    const params = new URLSearchParams({
      limit: "1000",
      start: String(start),
      end: String(end)
    });

    if (tradeIdTo) {
      params.set("tradeIdTo", tradeIdTo);
    }

    const raw = await bitvavo(
      `/${encodeURIComponent(market)}/trades?${params.toString()}`
    );

    const page: Trade[] = raw.map((t: any) => ({
      id: String(t.id),
      timestamp: Number(t.timestamp),
      amount: Number(t.amount),
      price: Number(t.price)
    }));

    if (page.length === 0) {
      break;
    }

    for (const trade of page) {
      tradesById.set(trade.id, trade);
    }

    if (page.length < 1000) {
      break;
    }

    const oldestTrade = page[page.length - 1];

    if (!oldestTrade.id) {
      throw new Error(
        `Cannot paginate trades for ${market}: missing trade id`
      );
    }

    if (tradeIdTo === oldestTrade.id) {
      throw new Error(
        `Trade pagination did not advance for ${market}`
      );
    }

    tradeIdTo = oldestTrade.id;
  }

  return Array.from(tradesById.values())
    .filter(
      trade =>
        trade.timestamp >= start &&
        trade.timestamp < end
    )
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Calcula el volumen monetario EUR de cada vela.
 *
 * Para cada trade:
 *
 *     EUR negociados = amount × price
 *
 * Después agrupa todos los trades según la vela
 * de intervalo correspondiente.
 */
async function getVolumeEURByCandle(
  market: string,
  interval: string,
  candles: Candle[]
): Promise<Map<number, number>> {
  const intervalMs = INTERVAL_MS[interval];

  if (!intervalMs) {
    throw new Error(`Unsupported interval: ${interval}`);
  }

  if (candles.length === 0) {
    throw new Error(`No candles available for ${market}`);
  }

  const start = candles[0].timestamp;
  const end =
    candles[candles.length - 1].timestamp + intervalMs;

  const trades = await getTradesForWindow(
    market,
    start,
    end
  );

  const volumeEURByCandle = new Map<number, number>();

  for (const candle of candles) {
    volumeEURByCandle.set(candle.timestamp, 0);
  }

  for (const trade of trades) {
    const candleStart =
      Math.floor(trade.timestamp / intervalMs) *
      intervalMs;

    if (!volumeEURByCandle.has(candleStart)) {
      continue;
    }

    const tradeVolumeEUR =
      trade.amount * trade.price;

    volumeEURByCandle.set(
      candleStart,
      (volumeEURByCandle.get(candleStart) ?? 0) +
        tradeVolumeEUR
    );
  }

  return volumeEURByCandle;
}

/**
 * Obtiene el libro de órdenes actual de Bitvavo.
 *
 * Usamos una profundidad fija de 20 niveles por lado:
 * 20 niveles de bids + 20 niveles de asks.
 *
 * Esto NO representa compras/ventas ejecutadas.
 * Representa liquidez actualmente colocada en el libro.
 */
async function getOrderBookPressure(
  market: string,
  depth: number
) {
  const raw: OrderBook =
    await bitvavo(
      `/${encodeURIComponent(
        market
      )}/book?depth=${depth}`
    );

  const bids = Array.isArray(raw.bids)
    ? raw.bids
    : [];

  const asks = Array.isArray(raw.asks)
    ? raw.asks
    : [];

  const bidDepthEUR = bids.reduce(
    (sum, level) => {
      const price = Number(level[0]);
      const size = Number(level[1]);

      return sum + price * size;
    },
    0
  );

  const askDepthEUR = asks.reduce(
    (sum, level) => {
      const price = Number(level[0]);
      const size = Number(level[1]);

      return sum + price * size;
    },
    0
  );

  const totalDepthEUR =
    bidDepthEUR + askDepthEUR;

  const bidPressurePct =
    totalDepthEUR > 0
      ? (bidDepthEUR / totalDepthEUR) * 100
      : null;

  const askPressurePct =
    totalDepthEUR > 0
      ? (askDepthEUR / totalDepthEUR) * 100
      : null;

  const orderBookImbalancePct =
    bidPressurePct !== null &&
    askPressurePct !== null
      ? bidPressurePct - askPressurePct
      : null;

  const bestBid =
    bids.length > 0
      ? Number(bids[0][0])
      : null;

  const bestAsk =
    asks.length > 0
      ? Number(asks[0][0])
      : null;

  const spreadEUR =
    bestBid !== null &&
    bestAsk !== null
      ? bestAsk - bestBid
      : null;

  const spreadPct =
    bestBid !== null &&
    bestAsk !== null &&
    bestBid > 0
      ? (spreadEUR! / bestBid) * 100
      : null;

  return {
    orderBookDepth: depth,

    bidDepthEUR,
    askDepthEUR,
    totalDepthEUR,

    bidPressurePct,
    askPressurePct,

    orderBookImbalancePct,

    bestBid,
    bestAsk,
    spreadEUR,
    spreadPct
  };
}

async function volumeEURAnomaly(
  market: string,
  interval: string,
  lookback: number,
  thresholdPct: number
) {
  if (!market.endsWith("-EUR")) {
    throw new Error(
      `This MCP only supports EUR markets: ${market}`
    );
  }

  const candles = await getClosedCandles(
    market,
    interval,
    lookback + 1
  );

  if (candles.length < lookback + 1) {
    throw new Error(
      `Not enough closed candles for ${market}: ` +
      `got ${candles.length}, need ${lookback + 1}`
    );
  }

  const volumeEURByCandle =
    await getVolumeEURByCandle(
      market,
      interval,
      candles
    );

  const latest =
    candles[candles.length - 1];

  const previous = candles.slice(
    candles.length - 1 - lookback,
    candles.length - 1
  );

  const latestVolumeEUR =
    volumeEURByCandle.get(latest.timestamp) ?? 0;

  const previousVolumesEUR =
    previous.map(
      candle =>
        volumeEURByCandle.get(
          candle.timestamp
        ) ?? 0
    );

  const averagePreviousVolumesEUR =
    previousVolumesEUR.reduce(
      (sum, volume) => sum + volume,
      0
    ) / previousVolumesEUR.length;

  const growthPct =
    averagePreviousVolumesEUR > 0
      ? ((latestVolumeEUR /
          averagePreviousVolumesEUR) -
          1) *
        100
      : null;

  const triggered =
    growthPct !== null &&
    growthPct >= thresholdPct;

  const direction =
    latest.close > latest.open
      ? "bullish"
      : latest.close < latest.open
        ? "bearish"
        : "neutral";

  return {
    market,
    interval,

    latestClosedCandleStart:
      new Date(
        latest.timestamp
      ).toISOString(),

    latestClosedCandleEnd:
      new Date(
        latest.timestamp +
          INTERVAL_MS[interval]
      ).toISOString(),

    latestVolumeEUR,
    averagePreviousVolumesEUR,
    growthPct,

    latestOpen: latest.open,
    latestClose: latest.close,
    direction,

    thresholdPct,
    triggered
  };
}

const server = new McpServer({
  name: "bitvavo-eur-volume-mcp",
  version: "1.1.0"
});

server.registerTool(
  "scan_eur_volume_anomalies",
  {
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },

    description:
      "Scan liquid Bitvavo EUR markets for anomalous CLOSED-candle EUR trading volume. " +
      "For each market, the latest closed candle EUR volume is calculated by summing " +
      "amount × price for all trades in that candle. It is compared with the average " +
      "EUR volume of the previous closed candles. Volume is always expressed in EUR. " +
      "For triggered anomalies, the current Bitvavo order book is also analyzed using " +
      "20 bid and 20 ask levels. Order-book pressure represents resting liquidity, " +
      "not executed buy/sell flow.",

    inputSchema: z.object({
      interval: z
        .enum([
          "1m",
          "5m",
          "15m",
          "30m",
          "1h",
          "2h",
          "4h",
          "6h",
          "8h",
          "12h",
          "1d"
        ])
        .default("5m"),

      lookback: z
        .number()
        .int()
        .min(2)
        .max(200)
        .default(20),

      thresholdPct: z
        .number()
        .min(0)
        .max(1000)
        .default(30),

      maxMarkets: z
        .number()
        .int()
        .min(5)
        .max(80)
        .default(40),

      minQuoteVolume24h: z
        .number()
        .min(0)
        .default(100000)
    })
  },

  async ({
    interval,
    lookback,
    thresholdPct,
    maxMarkets,
    minQuoteVolume24h
  }) => {
    const [markets, tickers] =
      await Promise.all([
        bitvavo("/markets"),
        bitvavo("/ticker/24h")
      ]);

    const allowed = new Set(
      markets
        .filter(
          (m: any) =>
            m.status === "trading" &&
            m.quote === "EUR"
        )
        .map(
          (m: any) => m.market
        )
    );

    const universe = tickers
      .filter(
        (t: any) =>
          allowed.has(t.market) &&
          Number(t.volumeQuote) >=
            minQuoteVolume24h
      )
      .sort(
        (a: any, b: any) =>
          Number(b.volumeQuote) -
          Number(a.volumeQuote)
      )
      .slice(0, maxMarkets);

    const results: any[] = [];
    const errors: any[] = [];

    for (
      let i = 0;
      i < universe.length;
      i += 4
    ) {
      const batch =
        universe.slice(i, i + 4);

      const batchResults =
        await Promise.all(
          batch.map(
            async (ticker: any) => {
              try {
                return await volumeEURAnomaly(
                  ticker.market,
                  interval,
                  lookback,
                  thresholdPct
                );
              } catch (error) {
                errors.push({
                  market: ticker.market,
                  error: String(error)
                });

                return null;
              }
            }
          )
        );

      results.push(
        ...batchResults.filter(
          Boolean
        )
      );
    }

    const anomalies =
      results
        .filter(
          result =>
            result.triggered
        )
        .sort(
          (a, b) =>
            (b.growthPct ??
              -Infinity) -
            (a.growthPct ??
              -Infinity)
        );

    /**
     * Solo analizamos el libro de órdenes
     * de las monedas que ya son anomalías.
     */
    const anomaliesWithOrderBook =
      await Promise.all(
        anomalies.map(
          async anomaly => {
            try {
              const orderBook =
                await getOrderBookPressure(
                  anomaly.market,
                  20
                );

              return {
                ...anomaly,
                orderBook
              };
            } catch (error) {
              return {
                ...anomaly,
                orderBook: null,
                orderBookError:
                  String(error)
              };
            }
          }
        )
      );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              metric:
                "EUR traded volume",

              calculation:
                "sum(amount × price) for every trade in each candle",

              criterion:
                `latest CLOSED ${interval} candle EUR volume >= ` +
                `previous ${lookback}-candle average + ${thresholdPct}%`,

              universe:
                `EUR markets with 24h quote volume >= ` +
                `${minQuoteVolume24h} EUR, capped at ${maxMarkets}`,

              checkedMarkets:
                universe.length,

              orderBookMetric:
                "20 levels per side; EUR value of resting bids versus asks",

              orderBookInterpretation:
                "bidPressurePct and askPressurePct represent resting order-book liquidity, not executed buy/sell volume",

              anomalies:
                anomaliesWithOrderBook,

              errors
            },
            null,
            2
          )
        }
      ]
    };
  }
);

const app =
  createMcpExpressApp({
    host: "0.0.0.0"
  });

app.get(
  "/",
  (_req: Request, res: Response) => {
    res.json({
      name:
        "bitvavo-eur-volume-mcp",

      status: "ok",

      mcpEndpoint:
        "/mcp",

      purpose:
        "Read-only Bitvavo EUR trading-volume MCP with order-book pressure"
    });
  }
);

app.post(
  "/mcp",
  async (
    req: Request,
    res: Response
  ) => {
    const transport =
      new NodeStreamableHTTPServerTransport({
        sessionIdGenerator:
          undefined
      });

    await server.connect(
      transport
    );

    await transport.handleRequest(
      req,
      res,
      req.body
    );
  }
);

const port =
  Number(process.env.PORT) ||
  3000;

app.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `Bitvavo EUR Volume MCP listening on port ${port}`
    );
  }
);
