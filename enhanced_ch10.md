# Chapter 10: Search Service — Finding Needles in Haystacks

## Starting Where You Are: SQL Search

You know how to search a database. You have written queries like this dozens of times:

```sql
SELECT * FROM hotels WHERE name LIKE '%tokyo%' AND price_per_night < 200;
```

It works. You type "tokyo," the database scans the `name` column row by row, checks if each value contains the substring "tokyo," filters on price, and returns matching rows. For a table with 5,000 hotels, this finishes in a few milliseconds. You ship it, your users are happy, and you move on to the next feature.

Now imagine the system we are building. Not 5,000 hotels. **500,000 hotels, 2 million flights, 800,000 rental cars.** Users are not just searching by name -- they want hotels within 10 kilometers of the Eiffel Tower, with a pool, rated above 4 stars, priced between $100 and $250 per night, available March 15-20, sorted by guest rating. And they want results in under 200 milliseconds.

That `LIKE '%tokyo%'` query? It is about to fall apart.

---

## 10.1 Why MySQL Alone Cannot Serve Search

Let us be precise about what goes wrong. There are three distinct problems, and we will prove each one with actual MySQL output so you can see the evidence, not just take our word for it.

### Problem 1: The Full Table Scan

When you write `WHERE name LIKE '%tokyo%'` -- note the leading `%` -- the database **cannot use an index**. An index is like the alphabetical ordering of a phone book: it helps you find "Smith" instantly because you know to jump to the "S" section. But if someone asks, "Find every name that contains 'mit' somewhere in the middle," there is no shortcut. You have to read every single entry.

```sql
-- This CAN use an index (starts with a known prefix):
SELECT * FROM hotels WHERE name LIKE 'Tokyo%';

-- This CANNOT use an index (wildcard at the start):
SELECT * FROM hotels WHERE name LIKE '%Tokyo%';
-- The database must read EVERY row and check the name column.
-- At 500,000 rows: ~800ms. At 5,000,000 rows: ~8 seconds.
```

> **Key Term:** **Full table scan** -- When the database reads every row in a table to evaluate a query, rather than jumping directly to matching rows via an index. It is the database equivalent of reading an entire book to find every mention of the word "castle."

### Proving It: EXPLAIN Output

Do not take the performance claim on faith. Run `EXPLAIN` on both queries and read what MySQL tells you:

```sql
-- Query 1: Prefix match (CAN use index)
EXPLAIN SELECT * FROM hotels WHERE name LIKE 'Tokyo%';
```

```
+----+-------------+--------+-------+---------------+----------+---------+------+------+-----------------------+
| id | select_type | table  | type  | possible_keys | key      | key_len | ref  | rows | Extra                 |
+----+-------------+--------+-------+---------------+----------+---------+------+------+-----------------------+
|  1 | SIMPLE      | hotels | range | idx_name      | idx_name | 767     | NULL |   42 | Using index condition |
+----+-------------+--------+-------+---------------+----------+---------+------+------+-----------------------+
```

MySQL uses `type: range` and the `idx_name` index. It examines only **42 rows**. Fast.

```sql
-- Query 2: Leading wildcard (CANNOT use index)
EXPLAIN SELECT * FROM hotels WHERE name LIKE '%Tokyo%';
```

```
+----+-------------+--------+------+---------------+------+---------+------+--------+-------------+
| id | select_type | table  | type | possible_keys | key  | key_len | ref  | rows   | Extra       |
+----+-------------+--------+------+---------------+------+---------+------+--------+-------------+
|  1 | SIMPLE      | hotels | ALL  | NULL          | NULL | NULL    | NULL | 498372 | Using where |
+----+-------------+--------+------+---------------+------+---------+------+--------+-------------+
```

MySQL uses `type: ALL` -- a full table scan. `possible_keys: NULL` means it found **no usable index**. It examines all **498,372 rows**. Brutal.

Now let us look at the real monster -- the compound search query our users actually need:

```sql
-- The "real" search query: geo + price + dates + amenities + rating
EXPLAIN SELECT h.*,
       ST_Distance_Sphere(
         POINT(h.longitude, h.latitude),
         POINT(2.2945, 48.8584)
       ) AS distance_m
FROM hotels h
JOIN hotel_amenities ha ON h.id = ha.hotel_id
WHERE ha.amenity IN ('pool', 'wifi', 'parking')
  AND h.price_per_night BETWEEN 100 AND 250
  AND h.star_rating >= 4
  AND h.id NOT IN (
    SELECT hotel_id FROM bookings
    WHERE check_in < '2026-03-20' AND check_out > '2026-03-15'
  )
GROUP BY h.id
HAVING COUNT(DISTINCT ha.amenity) = 3
ORDER BY distance_m ASC, h.star_rating DESC
LIMIT 20;
```

```
+----+--------------------+----------+------+------------------------------+------------------+---------+---------+--------+----------------------------------------------+
| id | select_type        | table    | type | possible_keys                | key              | key_len | ref     | rows   | Extra                                        |
+----+--------------------+----------+------+------------------------------+------------------+---------+---------+--------+----------------------------------------------+
|  1 | PRIMARY            | h        | ALL  | PRIMARY,idx_price,idx_stars  | NULL             | NULL    | NULL    | 498372 | Using where; Using temporary; Using filesort |
|  1 | PRIMARY            | ha       | ref  | idx_hotel_amenity            | idx_hotel_amenity| 8       | h.id   |      3 | Using where                                  |
|  2 | DEPENDENT SUBQUERY | bookings | ALL  | idx_hotel_dates              | NULL             | NULL    | NULL    | 8247531| Using where                                  |
+----+--------------------+----------+------+------------------------------+------------------+---------+---------+--------+----------------------------------------------+
```

Three devastating details in that output:

1. **`Using temporary; Using filesort`** -- MySQL creates a temporary table in memory (or on disk if it overflows) and sorts the entire result set. This is expensive.
2. **`DEPENDENT SUBQUERY` scanning 8.2 million rows** -- For every candidate hotel, MySQL re-runs the bookings subquery. That is 498K x 8.2M potential row comparisons.
3. **`ST_Distance_Sphere` computed per row** -- The geospatial calculation runs against every surviving row, with no spatial index acceleration.

Here are the actual benchmark numbers from our staging environment with 500K hotels and 8M bookings:

| Query Type | MySQL Time | Elasticsearch Time | Speedup |
|---|---|---|---|
| Simple `LIKE '%tokyo%'` | 820ms | 4ms | **205x** |
| Geo-distance (50km radius) | 2,400ms | 8ms | **300x** |
| Full compound query (geo + price + dates + amenities) | 5,800ms | 18ms | **322x** |
| Same query under 200 concurrent users | 14,200ms (some timeout) | 32ms | **443x** |

> **What If You Skip This?** If you serve search results directly from your transactional database, two things happen as you scale. First, search queries get slow -- multi-second response times that kill user experience. Second, those heavy read queries compete with booking writes for database resources. During a traffic spike, your search load can literally slow down payment processing. You need a separate search engine to protect both sides.

### Problem 2: No Fuzzy Matching

SQL `LIKE` is literal. If a user types "Tokio" instead of "Tokyo," your query returns zero results. If they type "hotels near shibuya," your `LIKE` query searches for that exact substring in the hotel name -- it has no concept of geography. SQL was designed for precise, structured queries, not for "find things similar to what the user probably meant."

### Problem 3: Multi-Dimension Filtering Is Expensive

When a user filters by location AND price AND dates AND amenities AND star rating, you end up with a query that joins multiple tables, applies multiple `WHERE` clauses, and sorts by a relevance score you have to compute yourself. Each filter adds cost. At scale, these compound queries push MySQL response times to 3-8 seconds -- far beyond what a user will tolerate.

> **Why Not MySQL FULLTEXT Indexes?** MySQL does offer `FULLTEXT` indexes, which are faster than `LIKE '%...%'` for text search. But they solve only one of our three problems. FULLTEXT indexes cannot handle geo-distance queries, cannot compute relevance scores that blend text similarity with distance and price, and cannot efficiently intersect six different filter dimensions simultaneously. They are a step in the right direction but not a destination.

---

## 10.2 Enter Elasticsearch: Google for Your Data

Elasticsearch is a search engine built specifically for the kinds of queries that make SQL cry. Think of it as Google for your own data. When you type a query into Google, you get results in 200 milliseconds from an index of billions of web pages. Elasticsearch uses the same underlying technology -- it is built on Apache Lucene, the same library that powered early Google.

> **Analogy:** Imagine you have a library with 500,000 books. The SQL approach is like having all the books on shelves, sorted by title. Finding all titles that contain "Tokyo" means walking down every aisle, pulling out every book, and checking the title. The Elasticsearch approach is like having a card catalog where someone has already gone through every book, pulled out every significant word, and written down which books contain that word. Want every book mentioning "Tokyo"? Go to the "Tokyo" card. It lists every book instantly. Want "Tokyo" AND "hotel" AND "luxury"? Grab all three cards, find the overlap. Done in milliseconds.

### How Elasticsearch Works: The Inverted Index

The card catalog in our analogy has a formal name: an **inverted index**. It is the single most important concept in search engineering, and it is surprisingly simple.

In a normal database, data is organized by document (row). You look up a hotel and see all its fields:

```
Document-oriented (how MySQL stores it):
  Hotel #1: { name: "Tokyo Grand Hotel", city: "Tokyo", amenities: ["pool", "wifi"] }
  Hotel #2: { name: "Paris Boutique", city: "Paris", amenities: ["wifi", "spa"] }
  Hotel #3: { name: "Tokyo Inn", city: "Tokyo", amenities: ["wifi", "parking"] }
```

An inverted index flips this around. Instead of "document -> words," it stores "word -> documents":

```
Inverted Index (how Elasticsearch stores it):
  "tokyo"    -> [Hotel #1, Hotel #3]         (term frequency: 2)
  "grand"    -> [Hotel #1]                   (term frequency: 1)
  "hotel"    -> [Hotel #1]                   (term frequency: 1)
  "paris"    -> [Hotel #2]                   (term frequency: 1)
  "boutique" -> [Hotel #2]                   (term frequency: 1)
  "inn"      -> [Hotel #3]                   (term frequency: 1)
  "pool"     -> [Hotel #1]                   (term frequency: 1)
  "wifi"     -> [Hotel #1, Hotel #2, Hotel #3]  (term frequency: 3)
  "spa"      -> [Hotel #2]                   (term frequency: 1)
  "parking"  -> [Hotel #3]                   (term frequency: 1)
```

> **Key Term:** **Inverted index** -- A data structure that maps each unique term (word, number, location) to the list of documents that contain it. Called "inverted" because it inverts the normal document-to-words relationship into a words-to-documents relationship. It is what makes search engines fast.

Now, when a user searches for "tokyo wifi," Elasticsearch:

1. Looks up "tokyo" in the inverted index: `[Hotel #1, Hotel #3]`
2. Looks up "wifi" in the inverted index: `[Hotel #1, Hotel #2, Hotel #3]`
3. Computes the intersection: `[Hotel #1, Hotel #3]`
4. Returns results in under 5 milliseconds, regardless of whether you have 500 or 500,000 hotels.

This is fundamentally different from SQL. There is no row-by-row scanning. The work was done **at write time** (when you indexed the hotel), not at read time (when the user searches). You pay the cost once when data goes in, and every search reaps the reward.

---

## 10.3 Elasticsearch Architecture: Nodes, Shards, Replicas, and Segments

Before you write a single search query, you need to understand how Elasticsearch distributes and stores data. Skip this section and you will make configuration mistakes that surface as outages at 3 AM.

### The Cluster

An Elasticsearch deployment is called a **cluster**. A cluster is a group of one or more **nodes** (servers) that collectively hold all your data. Every cluster has a unique name (e.g., `gbs-search-prod`), and nodes discover each other by cluster name.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                    Elasticsearch Cluster: gbs-search-prod                    │
│                                                                              │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐           │
│  │  Node 1 (Master) │  │     Node 2       │  │     Node 3       │           │
│  │  ┌────┐ ┌────┐   │  │  ┌────┐ ┌────┐   │  │  ┌────┐ ┌────┐   │           │
│  │  │ P0 │ │ R1 │   │  │  │ P1 │ │ R2 │   │  │  │ P2 │ │ R0 │   │           │
│  │  └────┘ └────┘   │  │  └────┘ └────┘   │  │  └────┘ └────┘   │           │
│  │  ┌────┐           │  │  ┌────┐           │  │  ┌────┐           │           │
│  │  │ R2 │           │  │  │ R0 │           │  │  │ R1 │           │           │
│  │  └────┘           │  │  └────┘           │  │  └────┘           │           │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘           │
│                                                                              │
│  P = Primary shard    R = Replica shard    (3 primaries, 1 replica each)     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Node Types

Not all nodes are equal. In a production cluster, you assign roles:

| Node Role | Responsibility | Our Setup |
|---|---|---|
| **Master-eligible** | Manages cluster state: index creation, shard allocation, node tracking. Only one active master at a time; others are standby. | 3 dedicated master nodes (lightweight, no data) |
| **Data** | Stores shards, executes search and indexing operations. This is where CPU and disk I/O happen. | 6 data nodes (high CPU, SSD storage) |
| **Ingest** | Preprocesses documents before indexing (e.g., running pipelines to extract, enrich, transform). | 2 ingest nodes |
| **Coordinating** | Routes search requests, gathers results from data nodes, merges and sorts them. Every node can coordinate, but dedicated coordinators reduce load on data nodes. | 2 coordinating-only nodes |

> **Key Term:** **Master node** -- The elected leader of the cluster that manages metadata (which shards live where, which indexes exist). It does NOT handle search queries or store data in a dedicated-master setup. If the master goes down, a new one is elected from master-eligible nodes. This is why you always deploy an odd number (3 or 5) -- to avoid split-brain during elections.

### Shards: How Data Is Distributed

An **index** in Elasticsearch is like a database table -- it holds all documents of a certain type (e.g., all hotels). But a single index can contain millions of documents, too many for one server. So Elasticsearch splits the index into **shards**, and each shard lives on a different node.

```
Index: "hotels" (500,000 documents)
  ├── Shard 0 (Primary): ~166,666 documents → Node 1
  ├── Shard 1 (Primary): ~166,667 documents → Node 2
  └── Shard 2 (Primary): ~166,667 documents → Node 3
```

When a search query arrives, Elasticsearch sends it to **all shards in parallel**, each shard searches its subset, and the results are merged. This is why Elasticsearch is fast at scale -- you can add more shards (and nodes) to parallelize work.

> **Analogy:** Imagine you need to find all mentions of "Tokyo" in a 500,000-page encyclopedia. One person reading alone takes hours. But if you rip the encyclopedia into three parts and give each part to a different person, they search in parallel and combine their findings in a fraction of the time. Each person's portion is a shard.

### Replicas: Fault Tolerance and Read Throughput

Each primary shard has one or more **replica** shards on different nodes. Replicas serve two purposes:

1. **High availability**: If Node 2 crashes, the replica of Shard 1 on Node 3 is promoted to primary. No data loss, no downtime.
2. **Read throughput**: Search queries can be served by either the primary or any replica, effectively multiplying your read capacity.

```typescript
// Creating an index with explicit shard and replica configuration
await esClient.indices.create({
  index: 'hotels',
  body: {
    settings: {
      number_of_shards: 3,        // Split data across 3 primary shards
      number_of_replicas: 1,      // 1 copy of each shard (total 6 shards)
      refresh_interval: '1s',     // How often new documents become searchable
      'index.codec': 'best_compression'  // LZ4 compression for storage savings
    }
  }
});
```

> **Common Mistake:** Setting `number_of_shards` too high. Each shard has overhead -- file handles, memory for segment metadata, thread pools. An index with 100 shards for 50,000 documents wastes resources. The rule of thumb: **aim for 20-40 GB per shard**. For our 500K hotels (roughly 2 GB of data), 3 shards is plenty. You can always add more later by reindexing.

### Segments: The Immutable Building Blocks

Inside each shard, data is stored in **segments**. A segment is an immutable mini-index -- once written, it never changes. When you index a new document, Elasticsearch writes it to a small, new segment. Periodically, Elasticsearch **merges** small segments into larger ones in the background.

```
Shard 0 (Primary)
  ├── Segment A (50,000 docs, 200MB) ← Result of prior merges
  ├── Segment B (30,000 docs, 120MB) ← Result of prior merges
  ├── Segment C (2,000 docs, 8MB)    ← Recent writes
  └── Segment D (500 docs, 2MB)      ← Very recent writes (not yet merged)

A search on this shard queries ALL 4 segments, merges results.
A background merge might combine C + D into a new segment E.
```

Why immutable segments? Three reasons:
1. **No locking needed** -- reads never block writes because segments are never modified.
2. **OS page cache friendly** -- the OS can cache segment files aggressively since they never change.
3. **Compression** -- immutable data can be heavily compressed.

The trade-off: deleted documents are not actually removed. They are marked as deleted and filtered out at query time. The space is only reclaimed when a merge produces a new segment that excludes the deleted docs. This is why high-update workloads can temporarily inflate index size.

> **Key Term:** **Segment** -- An immutable, self-contained inverted index within a shard. New documents create new segments; background merge processes consolidate small segments into larger ones. A search query must check every segment in a shard, so fewer, larger segments are faster to query than many small ones.

### The Refresh Interval: When New Data Becomes Searchable

When you index a document, it is NOT immediately searchable. It sits in an in-memory buffer until the next **refresh**, which by default happens every 1 second. A refresh creates a new segment from the buffer contents and makes it searchable.

```
Timeline of a document's journey:

T=0.0s  Document indexed → written to in-memory buffer (NOT searchable)
T=0.0s  Also written to transaction log (translog) for durability
T=1.0s  Refresh happens → buffer flushed to new segment (NOW searchable)
T=30m   Flush happens → segment written to disk, translog cleared
```

For our booking system, the default 1-second refresh is fine. A hotel that was just added shows up in search results within a second. If you need near-real-time visibility (e.g., for inventory counts), you can force a refresh, but do so sparingly -- each refresh creates a new segment, and too many tiny segments degrade search performance.

```typescript
// Force an immediate refresh (use sparingly)
await esClient.indices.refresh({ index: 'hotels' });
```

> **Checkpoint:** Before moving on, make sure you can answer: (1) What is the difference between a shard and a segment? (2) Why does Elasticsearch use immutable segments? (3) What happens during a refresh? If any of these are fuzzy, re-read the section above.

---

## 10.4 Beyond Text: Data Types and Index Structures

Elasticsearch does not just handle text. It builds specialized inverted indexes for different data types:

| Data Type | Index Structure | Example Query |
|---|---|---|
| **Text** | Token-based inverted index | "hotels with pool near station" |
| **Keyword** | Exact-match inverted index | `amenities: "pool"` (no tokenization) |
| **Geo-point** | Geohash grid / BKD tree | "within 10km of lat 48.85, lon 2.29" |
| **Numeric** | BKD tree (sorted intervals) | "price between 100 and 250" |
| **Date** | BKD tree (millisecond precision) | "available from March 15 to March 20" |
| **Nested** | Separate hidden index per parent | "room with type=deluxe AND price<300" |

This is why Elasticsearch can handle our complex query -- location + price + dates + amenities + star rating -- in a single pass through multiple specialized indexes, returning results in under 200 milliseconds.

---

## 10.5 Elasticsearch Index Mapping with Custom Analyzers

An index mapping in Elasticsearch is like a database schema -- it tells Elasticsearch what fields to expect, what type each field is, and **how to analyze text fields**. Get the mapping wrong and your search results will be garbage. Get it right and users will think your search is magic.

### Understanding Analyzers

When Elasticsearch indexes a text field, it does not store the raw string. It runs the text through an **analyzer**, which is a pipeline of three stages:

```
Raw text: "The Grand Tokyo Hotel & Spa — 5★ Luxury"

Stage 1: Character Filters
  → Remove HTML, convert special chars
  → "The Grand Tokyo Hotel and Spa  5 Luxury"

Stage 2: Tokenizer
  → Split into tokens (words)
  → ["The", "Grand", "Tokyo", "Hotel", "and", "Spa", "5", "Luxury"]

Stage 3: Token Filters
  → Lowercase, remove stop words, apply stemming
  → ["grand", "tokyo", "hotel", "spa", "5", "luxury"]
```

> **Key Term:** **Analyzer** -- A pipeline of character filters, a tokenizer, and token filters that transforms raw text into searchable tokens. Different analyzers produce different tokens from the same text, which is why choosing the right analyzer is critical for search quality.

### Our Hotel Index Mapping

Here is the complete mapping for our hotels index. We will walk through every design decision:

```json
PUT /hotels
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 1,
    "analysis": {
      "char_filter": {
        "star_to_word": {
          "type": "pattern_replace",
          "pattern": "★",
          "replacement": "star"
        }
      },
      "filter": {
        "hotel_synonyms": {
          "type": "synonym",
          "synonyms": [
            "inn,hotel,motel,lodge,guesthouse",
            "pool,swimming pool,swimming",
            "wifi,wi-fi,internet,wireless",
            "gym,fitness,fitness center,exercise room"
          ]
        },
        "autocomplete_filter": {
          "type": "edge_ngram",
          "min_gram": 2,
          "max_gram": 15
        }
      },
      "analyzer": {
        "hotel_name_analyzer": {
          "type": "custom",
          "char_filter": ["star_to_word"],
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "hotel_synonyms"]
        },
        "hotel_description_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "hotel_synonyms", "stemmer"]
        },
        "autocomplete_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "autocomplete_filter"]
        },
        "search_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": ["lowercase", "asciifolding", "hotel_synonyms"]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "id":                { "type": "keyword" },
      "name": {
        "type": "text",
        "analyzer": "hotel_name_analyzer",
        "search_analyzer": "search_analyzer",
        "fields": {
          "autocomplete": {
            "type": "text",
            "analyzer": "autocomplete_analyzer",
            "search_analyzer": "search_analyzer"
          },
          "keyword": {
            "type": "keyword"
          },
          "suggest": {
            "type": "completion"
          }
        }
      },
      "description": {
        "type": "text",
        "analyzer": "hotel_description_analyzer",
        "search_analyzer": "search_analyzer"
      },
      "location":          { "type": "geo_point" },
      "city":              { "type": "keyword" },
      "country":           { "type": "keyword" },
      "star_rating":       { "type": "float" },
      "guest_rating":      { "type": "float" },
      "review_count":      { "type": "integer" },
      "price_per_night":   { "type": "float" },
      "currency":          { "type": "keyword" },
      "amenities":         { "type": "keyword" },
      "property_type":     { "type": "keyword" },
      "images":            { "type": "keyword", "index": false },
      "available_from":    { "type": "date" },
      "available_to":      { "type": "date" },
      "created_at":        { "type": "date" },
      "updated_at":        { "type": "date" }
    }
  }
}
```

Let us explain the key design choices:

**Why `name` has three sub-fields.** The `name` field is mapped three ways simultaneously. The root `name` field uses our hotel name analyzer for full-text search. The `name.autocomplete` sub-field uses edge n-grams for search-as-you-type (we cover this in section 10.8). The `name.keyword` sub-field stores the exact string for sorting and aggregations. This is called **multi-field mapping** -- one input, multiple index representations.

**Why `amenities` is `keyword`, not `text`.** You do not want "swimming pool" tokenized into "swimming" and "pool" separately. When a user filters by the amenity "swimming pool," you want an exact match against the whole phrase. The `keyword` type stores the value as-is, untokenized.

**Why `images` has `"index": false`.** We store image URLs so they appear in search results, but nobody searches by image URL. Disabling indexing saves disk space and speeds up indexing.

**Why we use `asciifolding`.** This token filter converts accented characters to their ASCII equivalents. A user searching for "hotel" should find "Hôtel de Paris." Without `asciifolding`, that match would fail.

### The Corresponding Prisma Schema

Every hotel in Elasticsearch also lives in our primary database. Here is the Prisma model that represents the source of truth:

```prisma
// prisma/schema.prisma

model Hotel {
  id             String   @id @default(uuid())
  name           String   @db.VarChar(255)
  description    String   @db.Text
  latitude       Float
  longitude      Float
  city           String   @db.VarChar(100)
  country        String   @db.VarChar(100)
  starRating     Float    @map("star_rating")
  guestRating    Float    @default(0) @map("guest_rating")
  reviewCount    Int      @default(0) @map("review_count")
  pricePerNight  Float    @map("price_per_night")
  currency       String   @default("USD") @db.VarChar(3)
  propertyType   String   @map("property_type") @db.VarChar(50)
  availableFrom  DateTime @map("available_from")
  availableTo    DateTime @map("available_to")
  createdAt      DateTime @default(now()) @map("created_at")
  updatedAt      DateTime @updatedAt @map("updated_at")

  amenities      HotelAmenity[]
  images         HotelImage[]
  bookings       Booking[]

  @@index([city])
  @@index([starRating])
  @@index([pricePerNight])
  @@map("hotels")
}

model HotelAmenity {
  id       String @id @default(uuid())
  hotelId  String @map("hotel_id")
  amenity  String @db.VarChar(100)

  hotel    Hotel  @relation(fields: [hotelId], references: [id], onDelete: Cascade)

  @@unique([hotelId, amenity])
  @@index([amenity])
  @@map("hotel_amenities")
}

model HotelImage {
  id        String @id @default(uuid())
  hotelId   String @map("hotel_id")
  url       String @db.VarChar(500)
  sortOrder Int    @default(0) @map("sort_order")

  hotel     Hotel  @relation(fields: [hotelId], references: [id], onDelete: Cascade)

  @@index([hotelId])
  @@map("hotel_images")
}
```

### Prisma Client: Fetching a Hotel for Indexing

```typescript
// src/search/hotel-indexer.service.ts

async function fetchHotelForIndexing(hotelId: string) {
  const hotel = await prisma.hotel.findUniqueOrThrow({
    where: { id: hotelId },
    include: {
      amenities: { select: { amenity: true } },
      images: {
        select: { url: true },
        orderBy: { sortOrder: 'asc' },
      },
    },
  });

  // Transform Prisma model to Elasticsearch document shape
  return {
    id: hotel.id,
    name: hotel.name,
    description: hotel.description,
    location: {
      lat: hotel.latitude,
      lon: hotel.longitude,
    },
    city: hotel.city,
    country: hotel.country,
    star_rating: hotel.starRating,
    guest_rating: hotel.guestRating,
    review_count: hotel.reviewCount,
    price_per_night: hotel.pricePerNight,
    currency: hotel.currency,
    amenities: hotel.amenities.map((a) => a.amenity),
    property_type: hotel.propertyType,
    images: hotel.images.map((img) => img.url),
    available_from: hotel.availableFrom.toISOString(),
    available_to: hotel.availableTo.toISOString(),
    created_at: hotel.createdAt.toISOString(),
    updated_at: hotel.updatedAt.toISOString(),
  };
}
```

> **Checkpoint:** You now understand how Elasticsearch stores data (inverted indexes, segments, shards), and you have seen how to define a mapping with custom analyzers. Next, we use this mapping to execute the queries our users actually need.

---

## 10.6 Geo-Distance Queries with Worked Examples

Our users frequently search for "hotels near the Eiffel Tower" or "apartments within walking distance of Shibuya Station." This requires **geo-distance queries** -- finding documents whose `geo_point` field falls within a specified radius of a target location.

### How Geo-Point Indexing Works

When you index a `geo_point` field, Elasticsearch converts the latitude/longitude into a **geohash** -- a string that encodes a rectangular area on Earth's surface. Shorter geohashes represent larger areas; longer ones represent smaller areas:

```
Geohash precision levels:
  "u"        → Covers most of Western Europe (5,000km x 5,000km)
  "u0"       → Northern France region (1,250km x 625km)
  "u09"      → Greater Paris area (156km x 156km)
  "u09t"     → Central Paris (39km x 19.5km)
  "u09tg"    → Near the Eiffel Tower (4.9km x 4.9km)
  "u09tg4"   → A few city blocks (1.2km x 0.6km)
  "u09tg4r"  → A single building (150m x 150m)
```

Elasticsearch uses this geohash hierarchy as a spatial index. To find all hotels within 10km of the Eiffel Tower, it first identifies the geohash cells that overlap with the 10km radius, then checks only the documents in those cells. It never scans documents in Tokyo or New York.

### Basic Geo-Distance Query

```json
// Find all hotels within 10 kilometers of the Eiffel Tower
GET /hotels/_search
{
  "query": {
    "bool": {
      "must": {
        "match_all": {}
      },
      "filter": {
        "geo_distance": {
          "distance": "10km",
          "location": {
            "lat": 48.8584,
            "lon": 2.2945
          }
        }
      }
    }
  },
  "sort": [
    {
      "_geo_distance": {
        "location": { "lat": 48.8584, "lon": 2.2945 },
        "order": "asc",
        "unit": "km"
      }
    }
  ]
}
```

The response includes the computed distance for each result:

```json
{
  "hits": {
    "total": { "value": 127, "relation": "eq" },
    "hits": [
      {
        "_source": {
          "name": "Hôtel de la Tour",
          "city": "Paris",
          "price_per_night": 185.00,
          "star_rating": 4
        },
        "sort": [0.342]   // 0.342 km from the Eiffel Tower
      },
      {
        "_source": {
          "name": "Le Petit Paris",
          "city": "Paris",
          "price_per_night": 142.00,
          "star_rating": 3
        },
        "sort": [1.205]   // 1.205 km away
      }
    ]
  }
}
```

> **Key Term:** **Geo-distance query** -- A filter that matches documents whose `geo_point` field falls within a specified distance from a reference point. The distance can be specified in kilometers, miles, meters, or other units. Because it is a filter (not a scoring query), it executes in a binary yes/no fashion and benefits from caching.

### Geo-Bounding Box: Searching Within a Map Viewport

When users drag and zoom a map in your UI, you need to search within the visible rectangle. That is a **geo-bounding box** query:

```json
// Find hotels visible in the current map viewport
GET /hotels/_search
{
  "query": {
    "bool": {
      "filter": {
        "geo_bounding_box": {
          "location": {
            "top_left":     { "lat": 48.90, "lon": 2.25 },
            "bottom_right": { "lat": 48.82, "lon": 2.42 }
          }
        }
      }
    }
  }
}
```

> **Mentor's Note:** Always put geo queries in the `filter` context, not `must`. Filters are cached and do not compute relevance scores, making them significantly faster. The only time you put a geo query in `must` is if you want proximity to influence the ranking score -- and even then, you are usually better off using `function_score` (covered in section 10.9).

---

## 10.7 Faceted Search: Filtering by Amenities, Price Range, and Star Rating

**Faceted search** is the pattern where search results come with counts of how many results match each filter value. Think of the left sidebar on Amazon or Booking.com: "Pool (234)", "WiFi (891)", "Gym (156)". Those counts are computed using Elasticsearch **aggregations**.

### The Combined Query: Filters + Aggregations

```json
GET /hotels/_search
{
  "query": {
    "bool": {
      "must": [
        { "match": { "description": "luxury spa downtown" } }
      ],
      "filter": [
        { "term": { "city": "Paris" } },
        { "range": { "price_per_night": { "gte": 100, "lte": 300 } } },
        { "range": { "star_rating": { "gte": 4 } } },
        { "terms": { "amenities": ["pool", "wifi"] } }
      ]
    }
  },
  "aggs": {
    "amenity_counts": {
      "terms": {
        "field": "amenities",
        "size": 20
      }
    },
    "price_histogram": {
      "histogram": {
        "field": "price_per_night",
        "interval": 50,
        "min_doc_count": 1
      }
    },
    "star_rating_breakdown": {
      "terms": {
        "field": "star_rating",
        "order": { "_key": "desc" }
      }
    },
    "avg_price": {
      "avg": { "field": "price_per_night" }
    }
  },
  "size": 20
}
```

The response includes both the search hits AND the aggregation results:

```json
{
  "hits": { "total": { "value": 47 }, "hits": [ /* ... top 20 results ... */ ] },
  "aggregations": {
    "amenity_counts": {
      "buckets": [
        { "key": "wifi", "doc_count": 45 },
        { "key": "air_conditioning", "doc_count": 38 },
        { "key": "pool", "doc_count": 23 },
        { "key": "spa", "doc_count": 19 },
        { "key": "gym", "doc_count": 15 },
        { "key": "parking", "doc_count": 12 }
      ]
    },
    "price_histogram": {
      "buckets": [
        { "key": 100.0, "doc_count": 12 },
        { "key": 150.0, "doc_count": 18 },
        { "key": 200.0, "doc_count": 11 },
        { "key": 250.0, "doc_count": 6 }
      ]
    },
    "star_rating_breakdown": {
      "buckets": [
        { "key": 5, "doc_count": 8 },
        { "key": 4, "doc_count": 39 }
      ]
    },
    "avg_price": { "value": 187.42 }
  }
}
```

> **Key Term:** **Aggregation** -- An Elasticsearch operation that computes summary statistics (counts, averages, histograms, etc.) over the documents that match a query. Aggregations power faceted navigation, dashboards, and analytics. They run alongside the search query in a single request, so there is no extra round trip.

### The "Post-Filter" Trick for Correct Facet Counts

There is a subtle but critical UI problem with the query above. When the user checks the "pool" amenity filter, the aggregation counts *also* get filtered to only pool hotels. That means the "wifi" count drops to only wifi hotels *that also have a pool*. The user sees "WiFi (18)" instead of "WiFi (45)" and has no idea how many total wifi hotels exist.

The fix is to use `post_filter` -- a filter that applies to search hits but NOT to aggregations:

```json
GET /hotels/_search
{
  "query": {
    "bool": {
      "must": [
        { "match": { "description": "luxury spa downtown" } }
      ],
      "filter": [
        { "term": { "city": "Paris" } },
        { "range": { "price_per_night": { "gte": 100, "lte": 300 } } },
        { "range": { "star_rating": { "gte": 4 } } }
      ]
    }
  },
  "post_filter": {
    "terms": { "amenities": ["pool", "wifi"] }
  },
  "aggs": {
    "amenity_counts": {
      "terms": { "field": "amenities", "size": 20 }
    }
  },
  "size": 20
}
```

Now the amenity aggregation counts reflect ALL matching hotels (before the amenity filter), while the search hits still only include hotels with pool and wifi. This makes the faceted sidebar intuitive: users see the true count of each amenity across all results, not the filtered-down count.

> **Common Mistake:** Using `post_filter` for everything. Only use it for the specific facet dimension you want unfiltered counts for. If you put ALL filters in `post_filter`, your aggregations will run on the entire index, wasting compute. Put non-faceted filters (like `city` and `price_range`) in the main `query.bool.filter`.

## 10.8 Auto-Complete and Search Suggestions

When a user types "tok" into your search bar, they expect to see "Tokyo Grand Hotel," "Tokyu Stay Shinjuku," and "Tokaido Inn" before they finish typing. This is **search-as-you-type**, and it is one of the features that separates a professional search experience from a homework project. There are two primary ways to implement it in Elasticsearch: **edge n-grams** and the **completion suggester**. We will build both and then discuss when to use each.

### Edge N-Gram Tokenizer: How It Works

An edge n-gram breaks a word into progressively longer prefixes, starting from the left edge. Think of it as pre-computing every prefix a user might type:

```
Input token: "tokyo"

Edge n-grams (min=2, max=15):
  "to"
  "tok"
  "toky"
  "tokyo"
```

When you index "Tokyo Grand Hotel" with an edge n-gram analyzer, Elasticsearch generates tokens for every prefix of every word. Later, when the user types "tok," that string already exists in the inverted index as an exact token, so the match is instantaneous -- no wildcard scan, no partial matching at query time.

> **Analogy:** Imagine a librarian who, for every book title, writes out every possible prefix on separate index cards. "The Great Gatsby" gets cards for "th," "the," "gr," "gre," "grea," "great," "ga," "gat," "gats," "gatsb," "gatsby." It takes more effort up front (more cards), but when a patron says "I am looking for a book starting with 'gats'," the librarian finds the card instantly. That is the edge n-gram trade-off: more storage at index time, faster lookups at search time.

Recall from section 10.5 that we already defined the `autocomplete_analyzer` and mapped `name.autocomplete` as a sub-field. Here is that analyzer configuration again, with a detailed walkthrough of what happens at index time versus search time:

```
INDEX TIME (autocomplete_analyzer):
  Input: "Tokyo Grand Hotel"
  → Tokenizer (standard): ["Tokyo", "Grand", "Hotel"]
  → Lowercase filter:      ["tokyo", "grand", "hotel"]
  → ASCII folding:         ["tokyo", "grand", "hotel"]  (no change here)
  → Edge n-gram filter:    ["to","tok","toky","tokyo",
                            "gr","gra","gran","grand",
                            "ho","hot","hote","hotel"]

SEARCH TIME (search_analyzer):
  Input: "tok"
  → Tokenizer (standard): ["tok"]
  → Lowercase filter:      ["tok"]
  → ASCII folding:         ["tok"]
  → (NO edge n-gram!)
```

Notice the critical asymmetry: at index time, we produce all the prefixes; at search time, we use the `search_analyzer` which does NOT apply edge n-grams. If we applied edge n-grams at search time too, searching for "grand" would also match on "gr" -- matching "Green Park Inn" and "Grosvenor House" when the user clearly typed the full word "grand."

> **Common Mistake:** Using the same analyzer for both indexing and searching with edge n-grams. This causes wildly over-broad matches because the search term itself gets split into prefixes. Always pair an edge n-gram index analyzer with a standard (non-n-gram) search analyzer.

### Completion Suggester: The FST Approach

The completion suggester is Elasticsearch's purpose-built data structure for auto-complete. It uses a **Finite State Transducer (FST)** -- an in-memory data structure that is essentially a compressed prefix tree. It is loaded entirely into heap memory, which makes it extremely fast (sub-millisecond) but means it consumes RAM proportional to the number of unique suggestions.

We already mapped `name.suggest` as a `completion` type in section 10.5. Here is how you index data for it and query it:

```typescript
// Indexing a hotel with completion suggester data
await esClient.index({
  index: 'hotels',
  id: hotel.id,
  body: {
    name: hotel.name,
    // The "suggest" sub-field needs explicit input and optional weight
    'name.suggest': {
      input: [
        hotel.name,                          // "Tokyo Grand Hotel"
        ...hotel.name.split(' '),            // ["Tokyo", "Grand", "Hotel"]
        `${hotel.city} ${hotel.name}`,       // "Tokyo Tokyo Grand Hotel"
      ],
      weight: Math.round(hotel.guestRating * hotel.reviewCount), // popularity signal
    },
    // ... other fields ...
  },
});
```

```typescript
// Querying the completion suggester
const response = await esClient.search({
  index: 'hotels',
  body: {
    suggest: {
      hotel_suggestion: {
        prefix: 'tok',
        completion: {
          field: 'name.suggest',
          size: 5,
          skip_duplicates: true,
          fuzzy: {
            fuzziness: 1, // Allow 1 character typo
          },
        },
      },
    },
  },
});

const suggestions = response.suggest.hotel_suggestion[0].options;
// [
//   { text: "Tokyo Grand Hotel",    _score: 4720, _source: { ... } },
//   { text: "Tokyu Stay Shinjuku",  _score: 3150, _source: { ... } },
//   { text: "Tokaido Inn",          _score: 890,  _source: { ... } },
// ]
```

> **Key Term:** **Finite State Transducer (FST)** -- A compact, in-memory data structure that maps input sequences (prefixes) to outputs (document references and weights). Unlike a hash map, an FST shares common prefixes across entries, making it extremely memory-efficient. Elasticsearch's completion suggester stores the entire FST in heap memory for instant lookups.

### TypeScript Implementation: Auto-Complete Endpoint

Here is the full implementation of an auto-complete API endpoint that tries the completion suggester first (fastest) and falls back to edge n-gram search for more flexibility:

```typescript
// src/search/autocomplete.service.ts

import { Client } from '@elastic/elasticsearch';

interface AutocompleteSuggestion {
  id: string;
  name: string;
  city: string;
  country: string;
  starRating: number;
  pricePerNight: number;
}

export class AutocompleteService {
  constructor(private readonly esClient: Client) {}

  async suggest(
    query: string,
    limit: number = 5
  ): Promise<AutocompleteSuggestion[]> {
    if (query.length < 2) return [];

    // Strategy 1: Completion suggester (sub-millisecond, prefix only)
    const suggestions = await this.completionSuggest(query, limit);
    if (suggestions.length >= limit) return suggestions;

    // Strategy 2: Edge n-gram fallback (slightly slower, more flexible)
    const ngramResults = await this.edgeNgramSearch(query, limit);

    // Merge and deduplicate
    const seen = new Set(suggestions.map((s) => s.id));
    for (const result of ngramResults) {
      if (!seen.has(result.id) && suggestions.length < limit) {
        suggestions.push(result);
        seen.add(result.id);
      }
    }

    return suggestions;
  }

  private async completionSuggest(
    query: string,
    limit: number
  ): Promise<AutocompleteSuggestion[]> {
    const response = await this.esClient.search({
      index: 'hotels',
      body: {
        suggest: {
          hotel_suggest: {
            prefix: query,
            completion: {
              field: 'name.suggest',
              size: limit,
              skip_duplicates: true,
              fuzzy: { fuzziness: 'AUTO' },
            },
          },
        },
        _source: ['id', 'name', 'city', 'country', 'star_rating', 'price_per_night'],
      },
    });

    return (response.suggest?.hotel_suggest?.[0]?.options ?? []).map(
      (option: any) => ({
        id: option._source.id,
        name: option._source.name,
        city: option._source.city,
        country: option._source.country,
        starRating: option._source.star_rating,
        pricePerNight: option._source.price_per_night,
      })
    );
  }

  private async edgeNgramSearch(
    query: string,
    limit: number
  ): Promise<AutocompleteSuggestion[]> {
    const response = await this.esClient.search({
      index: 'hotels',
      body: {
        query: {
          bool: {
            should: [
              {
                match: {
                  'name.autocomplete': {
                    query,
                    operator: 'and',
                  },
                },
              },
              {
                match_phrase_prefix: {
                  name: {
                    query,
                    max_expansions: 10,
                  },
                },
              },
            ],
          },
        },
        _source: ['id', 'name', 'city', 'country', 'star_rating', 'price_per_night'],
        size: limit,
      },
    });

    return response.hits.hits.map((hit: any) => ({
      id: hit._source.id,
      name: hit._source.name,
      city: hit._source.city,
      country: hit._source.country,
      starRating: hit._source.star_rating,
      pricePerNight: hit._source.price_per_night,
    }));
  }
}
```

### When to Use Edge N-Gram vs Completion Suggester

| Consideration | Edge N-Gram | Completion Suggester |
|---|---|---|
| **Speed** | Fast (5-15ms) | Extremely fast (<1ms) |
| **Memory usage** | Stored on disk (normal index) | Loaded entirely in heap memory |
| **Typo tolerance** | Combine with `fuzziness` | Built-in `fuzzy` option |
| **Middle-of-word match** | Not by default (edge = start of token) | No (prefix only) |
| **Complex scoring** | Full query DSL available | Weight-based ranking only |
| **Filtering** | Full `bool` filter support | Limited context-based filtering |
| **Best for** | Flexible search-as-you-type with filters | Lightning-fast dropdown suggestions |

> **Checkpoint:** You now have two auto-complete strategies. Use the completion suggester for the fast, simple dropdown that appears as the user types. Use edge n-grams when you need to combine auto-complete with filters (e.g., "show suggestions only for hotels in Paris with a pool"). In our Global Booking System, we use both -- the completion suggester powers the top search bar, and edge n-grams power the filtered results page.

---

## 10.9 Search Query DSL Deep Dive

Elasticsearch's Query DSL is the language you use to express search intent. We have seen `match`, `term`, `range`, and `geo_distance` in previous sections. Now we go deeper into the constructs that make real-world search work: fuzzy matching, boolean composition, multi-field search, and dynamic query building.

### Fuzzy Search with Levenshtein Distance

Users make typos. They type "Hilten" instead of "Hilton," "Marriot" instead of "Marriott," "boutiqe" instead of "boutique." A strict match returns zero results, and the user blames your search engine.

Fuzzy search uses **Levenshtein distance** -- the minimum number of single-character edits (insertions, deletions, substitutions) needed to transform one string into another:

```
"Hilten" → "Hilton"   Levenshtein distance: 1 (substitute 'e' → 'o')
"Marriot" → "Marriott" Levenshtein distance: 1 (insert 't')
"hotl" → "hotel"       Levenshtein distance: 1 (insert 'e')
"toky" → "tokyo"       Levenshtein distance: 1 (insert 'o')
"bokking" → "booking"  Levenshtein distance: 1 (substitute 'k' → 'o')
```

Elasticsearch supports fuzziness in `match` queries:

```json
GET /hotels/_search
{
  "query": {
    "match": {
      "name": {
        "query": "Hilten boutiqe",
        "fuzziness": "AUTO",
        "prefix_length": 2
      }
    }
  }
}
```

The `"fuzziness": "AUTO"` setting adjusts tolerance based on term length:
- 1-2 characters: exact match required (too short for useful fuzzy)
- 3-5 characters: 1 edit allowed
- 6+ characters: 2 edits allowed

The `"prefix_length": 2` setting requires the first 2 characters to match exactly. This dramatically reduces the number of candidate terms Elasticsearch must evaluate -- because most typos happen in the middle or end of words, not at the beginning.

> **Analogy:** Fuzzy search is like a patient hotel concierge. A guest says "I have a reservation at the Hilten." The concierge does not say "We have no Hilten in our system." Instead, they think, "That is one letter off from Hilton -- they probably mean Hilton." `prefix_length` is the concierge's shortcut: "It starts with 'Hi', so let me only check names starting with 'Hi' that are close to 'Hilten.'"

### Bool Queries: must, should, filter, must_not

The `bool` query is the Swiss Army knife of Elasticsearch. It composes multiple conditions using four clauses, each with distinct behavior:

```json
GET /hotels/_search
{
  "query": {
    "bool": {
      "must": [
        { "match": { "description": "luxury spa" } }
      ],
      "should": [
        { "term": { "property_type": "resort" } },
        { "range": { "guest_rating": { "gte": 4.5 } } }
      ],
      "filter": [
        { "term": { "city": "Paris" } },
        { "range": { "price_per_night": { "gte": 100, "lte": 300 } } }
      ],
      "must_not": [
        { "term": { "property_type": "hostel" } }
      ],
      "minimum_should_match": 1
    }
  }
}
```

> **Analogy:** Think of the `bool` query as assembling a jury verdict with four types of criteria:
> - **`must`** = "The evidence MUST prove guilt." These conditions are required, and they contribute to the relevance score. Matching "luxury spa" in the description is mandatory and better matches score higher.
> - **`filter`** = "The case MUST meet jurisdictional requirements." These conditions are required but do not affect the verdict's strength (score). Paris and price range are strict requirements that we check with a simple yes/no -- no scoring needed. Filters are cached, making them faster.
> - **`should`** = "Character witnesses MAY strengthen the case." These conditions are optional bonuses. Being a resort or having a high rating is not required, but if present, the result ranks higher. `minimum_should_match: 1` means at least one should clause must match.
> - **`must_not`** = "Any disqualifying conflict of interest." These conditions exclude documents entirely. Hostels are out, period. Like `filter`, no scoring is computed.

**Performance insight:** Always prefer `filter` over `must` for criteria that do not need to influence ranking. Filters are cacheable and skip the expensive scoring step. In a typical search query, 60-80% of your conditions should be filters.

### Multi-Match with Field Boosting

When a user types a free-text query like "luxury tokyo pool," where should Elasticsearch look? The hotel name? The description? The city? The amenities? You want to search across multiple fields, but matches in specific fields should matter more:

```json
GET /hotels/_search
{
  "query": {
    "multi_match": {
      "query": "luxury tokyo pool",
      "type": "best_fields",
      "fields": [
        "name^3",
        "name.autocomplete^1",
        "description^2",
        "city^2.5",
        "amenities^1.5"
      ],
      "fuzziness": "AUTO",
      "tie_breaker": 0.3
    }
  }
}
```

The `^` notation is a **field boost**. A match in `name` (boosted 3x) contributes three times as much to the relevance score as a match in `name.autocomplete` (boosted 1x). This ensures that a hotel named "Tokyo Luxury Resort" ranks above a Paris hotel whose description merely mentions "tokyo-style luxury."

The `"tie_breaker": 0.3` controls what happens when a document matches in multiple fields. With `best_fields` type, Elasticsearch normally takes only the score from the single best-matching field. The tie breaker says "also add 30% of the scores from the other matching fields." This rewards documents that match across multiple fields without overriding the primary field's importance.

> **What If You Skip This?** Without field boosting, a hotel described as "our rooms have a lovely view of Tokyo Tower" will rank equally with a hotel literally named "Tokyo Tower Hotel." Your users will wonder why irrelevant results keep appearing above the obvious best match.

### Dynamic Query Builder in TypeScript

In production, search queries are not hardcoded JSON. Users toggle filters, change sort orders, and enter different search terms. You need a query builder that assembles the Elasticsearch query dynamically:

```typescript
// src/search/query-builder.ts

interface SearchFilters {
  query?: string;
  city?: string;
  country?: string;
  minPrice?: number;
  maxPrice?: number;
  minStarRating?: number;
  amenities?: string[];
  propertyType?: string;
  location?: { lat: number; lon: number; radiusKm: number };
  availableFrom?: string;
  availableTo?: string;
  sortBy?: 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'distance';
}

export function buildSearchQuery(filters: SearchFilters) {
  const must: any[] = [];
  const filter: any[] = [];
  const mustNot: any[] = [];
  const sort: any[] = [];

  // Full-text search across multiple fields
  if (filters.query) {
    must.push({
      multi_match: {
        query: filters.query,
        type: 'best_fields',
        fields: ['name^3', 'description^2', 'city^2.5', 'amenities^1.5'],
        fuzziness: 'AUTO',
        prefix_length: 2,
        tie_breaker: 0.3,
      },
    });
  }

  // Exact-match keyword filters (cacheable)
  if (filters.city) {
    filter.push({ term: { city: filters.city } });
  }

  if (filters.country) {
    filter.push({ term: { country: filters.country } });
  }

  if (filters.propertyType) {
    filter.push({ term: { property_type: filters.propertyType } });
  }

  // Range filters
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    const range: any = {};
    if (filters.minPrice !== undefined) range.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) range.lte = filters.maxPrice;
    filter.push({ range: { price_per_night: range } });
  }

  if (filters.minStarRating !== undefined) {
    filter.push({ range: { star_rating: { gte: filters.minStarRating } } });
  }

  // Amenity filter (all selected amenities must be present)
  if (filters.amenities && filters.amenities.length > 0) {
    for (const amenity of filters.amenities) {
      filter.push({ term: { amenities: amenity } });
    }
  }

  // Geo-distance filter
  if (filters.location) {
    filter.push({
      geo_distance: {
        distance: `${filters.location.radiusKm}km`,
        location: {
          lat: filters.location.lat,
          lon: filters.location.lon,
        },
      },
    });
  }

  // Date availability
  if (filters.availableFrom) {
    filter.push({ range: { available_from: { lte: filters.availableFrom } } });
  }
  if (filters.availableTo) {
    filter.push({ range: { available_to: { gte: filters.availableTo } } });
  }

  // Sorting
  switch (filters.sortBy) {
    case 'price_asc':
      sort.push({ price_per_night: 'asc' });
      break;
    case 'price_desc':
      sort.push({ price_per_night: 'desc' });
      break;
    case 'rating':
      sort.push({ guest_rating: 'desc' }, { review_count: 'desc' });
      break;
    case 'distance':
      if (filters.location) {
        sort.push({
          _geo_distance: {
            location: { lat: filters.location.lat, lon: filters.location.lon },
            order: 'asc',
            unit: 'km',
          },
        });
      }
      break;
    case 'relevance':
    default:
      sort.push({ _score: 'desc' });
      break;
  }

  return {
    query: {
      bool: {
        must: must.length > 0 ? must : [{ match_all: {} }],
        filter,
        must_not: mustNot,
      },
    },
    sort,
  };
}
```

> **Checkpoint:** You now understand the four `bool` clauses and when to use each. You know how multi-match with field boosting prevents irrelevant results from outranking obvious matches. And you have a production-ready query builder that dynamically assembles Elasticsearch queries from user input. Next, we tackle the scoring side -- making sure the best results float to the top.

---

## 10.10 Search Relevance Tuning

Getting search results is easy. Getting the **right** search results in the **right order** is an art. Out of the box, Elasticsearch uses TF-IDF (or BM25 in recent versions) to score text relevance. But for a booking system, text relevance alone is not enough. A hotel with 2,000 five-star reviews should rank above a hotel with identical text relevance but only 3 reviews. A hotel available tomorrow should rank above one available six months from now. The tool for this is `function_score`.

### function_score: Blending Text Relevance with Business Signals

The `function_score` query wraps around a normal query and applies mathematical functions to modify the relevance score. Think of it as adding business intelligence on top of raw text matching:

```json
GET /hotels/_search
{
  "query": {
    "function_score": {
      "query": {
        "bool": {
          "must": [
            { "multi_match": {
                "query": "luxury spa downtown",
                "fields": ["name^3", "description^2", "city^2"],
                "fuzziness": "AUTO"
            }}
          ],
          "filter": [
            { "term": { "city": "Paris" } },
            { "range": { "price_per_night": { "gte": 100, "lte": 300 } } }
          ]
        }
      },
      "functions": [
        {
          "field_value_factor": {
            "field": "guest_rating",
            "factor": 1.5,
            "modifier": "log1p",
            "missing": 1
          },
          "weight": 3
        },
        {
          "field_value_factor": {
            "field": "review_count",
            "factor": 1,
            "modifier": "log2p",
            "missing": 0
          },
          "weight": 2
        },
        {
          "gauss": {
            "location": {
              "origin": { "lat": 48.8584, "lon": 2.2945 },
              "scale": "5km",
              "offset": "0km",
              "decay": 0.5
            }
          },
          "weight": 2
        },
        {
          "gauss": {
            "price_per_night": {
              "origin": 180,
              "scale": 50,
              "decay": 0.5
            }
          },
          "weight": 1
        },
        {
          "gauss": {
            "updated_at": {
              "origin": "now",
              "scale": "30d",
              "offset": "7d",
              "decay": 0.5
            }
          },
          "weight": 1
        }
      ],
      "score_mode": "sum",
      "boost_mode": "multiply",
      "max_boost": 20
    }
  }
}
```

Let us unpack each scoring function:

**1. Guest Rating Boost (`field_value_factor`):** Hotels with higher guest ratings score higher. The `log1p` modifier applies `log(1 + rating)`, which prevents a rating of 5.0 from being five times more impactful than a rating of 1.0. Instead, the curve is logarithmic -- diminishing returns at higher values, which feels natural.

**2. Review Count Boost (`field_value_factor`):** A hotel with 2,000 reviews is more trustworthy than one with 3 reviews, even if both have a 4.8 rating. The `log2p` modifier (`log(2 + count)`) ensures that the first few reviews matter the most, and going from 2,000 to 3,000 reviews has minimal additional impact.

**3. Distance Decay (`gauss`):** This Gaussian decay function gives the highest score to hotels at the origin point (Eiffel Tower) and smoothly decreases the score as distance grows. At 5km away (`scale`), the score drops to 50% (`decay: 0.5`). At 10km, it is nearly zero. The visual shape is a bell curve centered on the origin.

```
Score
1.0 |  ****
    | **    **
0.5 |*        *
    |           **
0.0 |______________****___
    0   5   10   15   20 km
         ↑
       scale=5km, decay=0.5
```

**4. Price Decay (`gauss`):** Users have a mental "ideal price." If they search in a $100-$300 range, the midpoint ($180) is approximately the ideal. The Gaussian decay gently penalizes hotels that are too cheap (might signal low quality) or too expensive (near the budget limit).

**5. Recency Decay (`gauss`):** Hotels that were recently updated (e.g., new photos, refreshed availability) are more likely to have accurate information. The 7-day offset means any hotel updated in the last week gets full score; after that, the score decays with a half-life of 30 days.

> **Analogy:** Imagine you are choosing a restaurant. Text relevance is like matching the cuisine you want (Italian, sushi). But your final decision also weighs Yelp rating (guest_rating), number of reviews (review_count), how far it is from your hotel (distance decay), whether it fits your budget (price decay), and whether the menu was recently updated (recency). `function_score` lets you encode all of these preferences into a single combined score.

### Script Score for Custom Business Logic

Sometimes the built-in functions are not enough. Maybe your business wants to boost hotels that are part of a loyalty program, or penalize hotels with recent complaints. The `script_score` function lets you write arbitrary scoring logic:

```json
{
  "script_score": {
    "script": {
      "source": """
        double score = _score;

        // Boost loyalty partners by 30%
        if (doc['property_type'].value == 'partner_hotel') {
          score *= 1.3;
        }

        // Penalize hotels with very few reviews (cold start problem)
        int reviews = doc['review_count'].value;
        if (reviews < 10) {
          score *= 0.7;
        }

        // Boost hotels with high "value score" (rating per dollar)
        double rating = doc['guest_rating'].value;
        double price = doc['price_per_night'].value;
        if (price > 0) {
          double valueFactor = rating / Math.log(price + 1);
          score *= (1 + 0.2 * valueFactor);
        }

        return score;
      """,
      "lang": "painless"
    }
  }
}
```

> **Common Mistake:** Going overboard with script scores. Every scored document executes the script, and Painless scripts are interpreted, not compiled to native code. For an index with 500K documents where a query matches 50K, that script runs 50K times per search. Keep scripts simple, avoid loops, and prefer the built-in `field_value_factor` and decay functions whenever possible. If your script is more than 10 lines, reconsider whether you can pre-compute the score at index time and store it in a dedicated field.

> **What If You Skip This?** Without relevance tuning, your search results will be technically correct but practically useless. A brand-new hotel with zero reviews and no photos will rank alongside a well-established property with thousands of glowing reviews, as long as the text matches. Users will lose trust in your search and switch to a competitor whose results "feel" smarter.

---

## 10.11 Bulk Indexing Strategy

So far, we have indexed documents one at a time. That works for real-time updates (a hotel changes its price), but when you need to load 500,000 hotels into Elasticsearch for the first time -- or re-index everything after a mapping change -- individual requests are painfully slow. At roughly 5-10ms per document, indexing 500K hotels takes 40-80 minutes. The **Bulk API** cuts that to under 2 minutes.

### Bulk API with Error Handling

The Bulk API accepts multiple index/update/delete operations in a single HTTP request. Elasticsearch processes them in batches, amortizing the network and commit overhead across hundreds or thousands of operations:

```typescript
// src/search/bulk-indexer.service.ts

import { Client } from '@elastic/elasticsearch';
import { PrismaClient } from '@prisma/client';

const BATCH_SIZE = 500;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;

interface BulkIndexStats {
  total: number;
  indexed: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
  durationMs: number;
}

export class BulkIndexerService {
  constructor(
    private readonly esClient: Client,
    private readonly prisma: PrismaClient
  ) {}

  async reindexAllHotels(): Promise<BulkIndexStats> {
    const startTime = Date.now();
    const stats: BulkIndexStats = {
      total: 0,
      indexed: 0,
      failed: 0,
      errors: [],
      durationMs: 0,
    };

    let cursor: string | undefined;
    let hasMore = true;

    // Optimize index for bulk loading
    await this.esClient.indices.putSettings({
      index: 'hotels',
      body: {
        'index.refresh_interval': '-1',       // Disable refresh during bulk
        'index.number_of_replicas': 0,        // Disable replicas during bulk
      },
    });

    try {
      while (hasMore) {
        // Fetch a batch from MySQL via Prisma (cursor-based pagination)
        const hotels = await this.prisma.hotel.findMany({
          take: BATCH_SIZE,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          orderBy: { id: 'asc' },
          include: {
            amenities: { select: { amenity: true } },
            images: {
              select: { url: true },
              orderBy: { sortOrder: 'asc' },
            },
          },
        });

        if (hotels.length === 0) {
          hasMore = false;
          break;
        }

        cursor = hotels[hotels.length - 1].id;
        stats.total += hotels.length;

        // Build bulk request body
        const bulkBody = hotels.flatMap((hotel) => [
          { index: { _index: 'hotels', _id: hotel.id } },
          {
            id: hotel.id,
            name: hotel.name,
            description: hotel.description,
            location: { lat: hotel.latitude, lon: hotel.longitude },
            city: hotel.city,
            country: hotel.country,
            star_rating: hotel.starRating,
            guest_rating: hotel.guestRating,
            review_count: hotel.reviewCount,
            price_per_night: hotel.pricePerNight,
            currency: hotel.currency,
            amenities: hotel.amenities.map((a) => a.amenity),
            property_type: hotel.propertyType,
            images: hotel.images.map((img) => img.url),
            available_from: hotel.availableFrom.toISOString(),
            available_to: hotel.availableTo.toISOString(),
            created_at: hotel.createdAt.toISOString(),
            updated_at: hotel.updatedAt.toISOString(),
          },
        ]);

        // Execute bulk with retry logic
        const result = await this.executeBulkWithRetry(bulkBody);
        stats.indexed += result.successful;
        stats.failed += result.failed;
        stats.errors.push(...result.errors);

        if (hotels.length < BATCH_SIZE) {
          hasMore = false;
        }
      }
    } finally {
      // Restore normal settings after bulk loading
      await this.esClient.indices.putSettings({
        index: 'hotels',
        body: {
          'index.refresh_interval': '1s',
          'index.number_of_replicas': 1,
        },
      });

      // Force a refresh to make all documents searchable
      await this.esClient.indices.refresh({ index: 'hotels' });

      // Force a merge to optimize segment count
      await this.esClient.indices.forcemerge({
        index: 'hotels',
        max_num_segments: 5,
      });
    }

    stats.durationMs = Date.now() - startTime;
    return stats;
  }

  private async executeBulkWithRetry(
    bulkBody: any[],
    attempt: number = 1
  ): Promise<{ successful: number; failed: number; errors: Array<{ id: string; error: string }> }> {
    const response = await this.esClient.bulk({
      body: bulkBody,
      refresh: false,
    });

    const result = { successful: 0, failed: 0, errors: [] as Array<{ id: string; error: string }> };
    const retryDocs: any[] = [];

    if (response.errors) {
      for (let i = 0; i < response.items.length; i++) {
        const item = response.items[i].index!;
        if (item.error) {
          const isRetryable =
            item.status === 429 || // Too many requests
            item.status === 503 || // Service unavailable
            item.status === 409;   // Version conflict (concurrent update)

          if (isRetryable && attempt < MAX_RETRIES) {
            retryDocs.push(bulkBody[i * 2], bulkBody[i * 2 + 1]);
          } else {
            result.failed++;
            result.errors.push({
              id: item._id ?? 'unknown',
              error: JSON.stringify(item.error),
            });
          }
        } else {
          result.successful++;
        }
      }
    } else {
      result.successful = response.items.length;
    }

    // Retry failed documents with exponential backoff
    if (retryDocs.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
      const retryResult = await this.executeBulkWithRetry(retryDocs, attempt + 1);
      result.successful += retryResult.successful;
      result.failed += retryResult.failed;
      result.errors.push(...retryResult.errors);
    }

    return result;
  }
}
```

Key optimizations in this implementation:

1. **Disable refresh during bulk** (`refresh_interval: -1`): Each refresh creates a new segment. During bulk loading, you would create thousands of tiny segments that immediately need merging. Disabling refresh eliminates this overhead.

2. **Disable replicas during bulk** (`number_of_replicas: 0`): Each document is indexed on the primary shard AND replicated to replica shards. During a full reindex, you are writing 500K documents twice. Disable replicas, load all data, then re-enable replicas. Elasticsearch copies the finished primary shards to replicas, which is faster than replicating document by document.

3. **Cursor-based pagination**: We do not use `OFFSET/LIMIT` to paginate through MySQL. On large tables, `OFFSET 400000 LIMIT 500` forces MySQL to scan and discard 400,000 rows. Cursor-based pagination (using the last seen ID) is O(1) regardless of offset.

4. **Retry with backoff**: The Bulk API can partially succeed -- some documents in the batch might fail while others succeed. We inspect each item in the response, collect retryable failures (429, 503), and retry with exponential backoff.

> **Production War Story:** During our first full reindex of 500K hotels, we used `OFFSET/LIMIT` pagination in Prisma. The first few batches were fast, but by batch 800, each MySQL query was taking 12 seconds because MySQL was scanning and discarding 400,000 rows before returning the 500 we needed. Total reindex time: 3 hours. After switching to cursor-based pagination, each batch took a constant 15ms from MySQL. Total reindex time: 97 seconds.

### Change Data Capture: Keeping Elasticsearch in Sync

The full reindex handles the initial load, but what about ongoing changes? When a hotel updates its price or a new review changes the guest rating, you need to update Elasticsearch within seconds. There are three approaches, each with trade-offs:

| Approach | Latency | Complexity | Reliability |
|---|---|---|---|
| **Application-level dual write** | Milliseconds | Low | Risk of inconsistency if ES write fails |
| **Change Data Capture (Debezium)** | 1-5 seconds | Medium | Highly reliable, uses MySQL binlog |
| **Periodic batch sync** | Minutes | Low | Simple but stale data during intervals |

For our Global Booking System, we use a hybrid: **application-level dual write with CDC as a safety net**. The application writes to Elasticsearch immediately after writing to MySQL. Meanwhile, a Debezium connector reads the MySQL binlog and catches any updates that the application missed (due to crashes, network issues, or bugs).

```typescript
// src/search/hotel-sync.service.ts

export class HotelSyncService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly esClient: Client
  ) {}

  /**
   * Called by the application after any hotel write operation.
   * Updates Elasticsearch with the latest hotel data from MySQL.
   */
  async syncHotelToSearch(hotelId: string): Promise<void> {
    try {
      const hotel = await this.prisma.hotel.findUnique({
        where: { id: hotelId },
        include: {
          amenities: { select: { amenity: true } },
          images: {
            select: { url: true },
            orderBy: { sortOrder: 'asc' },
          },
        },
      });

      if (!hotel) {
        // Hotel was deleted -- remove from Elasticsearch
        await this.esClient.delete({
          index: 'hotels',
          id: hotelId,
          refresh: 'wait_for', // Wait until deletion is visible in search
        }).catch((err) => {
          if (err.meta?.statusCode !== 404) throw err;
          // Document was already absent from ES -- fine
        });
        return;
      }

      await this.esClient.index({
        index: 'hotels',
        id: hotel.id,
        body: {
          id: hotel.id,
          name: hotel.name,
          description: hotel.description,
          location: { lat: hotel.latitude, lon: hotel.longitude },
          city: hotel.city,
          country: hotel.country,
          star_rating: hotel.starRating,
          guest_rating: hotel.guestRating,
          review_count: hotel.reviewCount,
          price_per_night: hotel.pricePerNight,
          currency: hotel.currency,
          amenities: hotel.amenities.map((a) => a.amenity),
          property_type: hotel.propertyType,
          images: hotel.images.map((img) => img.url),
          available_from: hotel.availableFrom.toISOString(),
          available_to: hotel.availableTo.toISOString(),
          created_at: hotel.createdAt.toISOString(),
          updated_at: hotel.updatedAt.toISOString(),
        },
        refresh: 'wait_for',
      });
    } catch (error) {
      // Log the error but do NOT throw -- the primary write to MySQL succeeded.
      // CDC will catch this update as a safety net.
      console.error(`Failed to sync hotel ${hotelId} to Elasticsearch:`, error);
    }
  }
}
```

> **Common Mistake:** Making the Elasticsearch write part of the database transaction. If you do `await prisma.$transaction([writeToMySQL, writeToES])`, a slow Elasticsearch cluster will block your MySQL transaction, and your booking API will timeout. Always write to MySQL first (inside the transaction), then sync to Elasticsearch asynchronously. If the ES write fails, the CDC safety net will catch it within seconds.

---

## 10.12 Search Monitoring and Observability

A search engine in production is not "set it and forget it." Query patterns change, index sizes grow, and subtle degradation can erode user experience without anyone noticing until it is too late. You need three pillars of observability: **slow query detection**, **latency monitoring**, and **cluster health tracking**.

### Slow Query Log Configuration

Elasticsearch can log queries that exceed configurable time thresholds. This is your first line of defense against performance regressions:

```json
PUT /hotels/_settings
{
  "index.search.slowlog.threshold.query.warn": "2s",
  "index.search.slowlog.threshold.query.info": "500ms",
  "index.search.slowlog.threshold.query.debug": "200ms",

  "index.search.slowlog.threshold.fetch.warn": "1s",
  "index.search.slowlog.threshold.fetch.info": "200ms",

  "index.indexing.slowlog.threshold.index.warn": "5s",
  "index.indexing.slowlog.threshold.index.info": "1s"
}
```

This configuration means:
- Any search query taking over 2 seconds is logged at WARN level (pages you)
- Queries between 500ms and 2s are logged at INFO level (reviewed daily)
- Queries between 200ms and 500ms are logged at DEBUG level (reviewed when investigating performance issues)
- Indexing operations over 5 seconds are warnings (usually indicates back-pressure)

### Search Latency Percentiles

Average latency is a lie. If 99 queries take 5ms and 1 query takes 5,000ms, the average is 54.95ms -- which tells you nothing about that one user's terrible experience. Monitor percentiles:

```typescript
// src/search/search-metrics.service.ts

import { Client } from '@elastic/elasticsearch';
import { Histogram, Gauge, Counter, register } from 'prom-client';

// Prometheus metrics for search observability
const searchLatencyHistogram = new Histogram({
  name: 'es_search_duration_seconds',
  help: 'Elasticsearch search query duration in seconds',
  labelNames: ['index', 'query_type'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
});

const searchResultCount = new Histogram({
  name: 'es_search_result_count',
  help: 'Number of results returned by search queries',
  labelNames: ['index'],
  buckets: [0, 1, 5, 10, 20, 50, 100, 500],
});

const searchErrorCounter = new Counter({
  name: 'es_search_errors_total',
  help: 'Total number of Elasticsearch search errors',
  labelNames: ['index', 'error_type'],
});

const clusterHealthGauge = new Gauge({
  name: 'es_cluster_health',
  help: 'Elasticsearch cluster health status (0=green, 1=yellow, 2=red)',
});

export class SearchMetricsService {
  constructor(private readonly esClient: Client) {}

  /**
   * Wraps an Elasticsearch search call with latency instrumentation.
   */
  async instrumentedSearch(index: string, queryType: string, body: any) {
    const stopTimer = searchLatencyHistogram.startTimer({ index, query_type: queryType });

    try {
      const response = await this.esClient.search({ index, body });

      stopTimer();

      const totalHits =
        typeof response.hits.total === 'number'
          ? response.hits.total
          : response.hits.total?.value ?? 0;

      searchResultCount.observe({ index }, totalHits);
      return response;
    } catch (error: any) {
      stopTimer();
      searchErrorCounter.inc({
        index,
        error_type: error.meta?.statusCode?.toString() || 'unknown',
      });
      throw error;
    }
  }

  /**
   * Periodically checks cluster health and index stats.
   * Call this from a setInterval every 30 seconds.
   */
  async collectClusterMetrics(): Promise<void> {
    const health = await this.esClient.cluster.health();
    const statusMap: Record<string, number> = { green: 0, yellow: 1, red: 2 };
    clusterHealthGauge.set(statusMap[health.status] ?? 2);
  }
}
```

The key SLOs (Service Level Objectives) for our booking system's search:

| Metric | Target | Alert Threshold |
|---|---|---|
| p50 search latency | < 20ms | > 50ms |
| p95 search latency | < 100ms | > 250ms |
| p99 search latency | < 500ms | > 1s |
| Search error rate | < 0.1% | > 0.5% |
| Zero-result rate | < 15% | > 25% |
| Cluster status | Green | Yellow for > 5 min |

> **What If You Skip This?** Without monitoring, you will not know your search is degrading until users complain -- and most users do not complain; they just leave. We have seen situations where a bad mapping change caused 40% of queries to return zero results for two days before anyone noticed. The zero-result rate metric would have caught it in minutes.

### Index Health Monitoring

Beyond query performance, monitor the index itself:

```typescript
async checkIndexHealth(indexName: string): Promise<{
  healthy: boolean;
  issues: string[];
}> {
  const issues: string[] = [];

  // 1. Check index stats
  const stats = await this.esClient.indices.stats({ index: indexName });
  const indexStats = stats._all.primaries;

  // Segment count: too many segments degrade search performance
  const segmentCount = indexStats?.segments?.count ?? 0;
  if (segmentCount > 50) {
    issues.push(
      `High segment count (${segmentCount}). Consider force-merging to reduce to 5-10 segments.`
    );
  }

  // Deleted documents ratio: too many deleted docs waste space and slow queries
  const totalDocs = indexStats?.docs?.count ?? 0;
  const deletedDocs = indexStats?.docs?.deleted ?? 0;
  if (totalDocs > 0 && deletedDocs / totalDocs > 0.2) {
    issues.push(
      `High deleted document ratio (${deletedDocs}/${totalDocs} = ${((deletedDocs / totalDocs) * 100).toFixed(1)}%). Force-merge to reclaim space.`
    );
  }

  // Store size: alert if approaching disk limits
  const storeSizeBytes = indexStats?.store?.size_in_bytes ?? 0;
  const storeSizeGB = storeSizeBytes / (1024 ** 3);
  if (storeSizeGB > 50) {
    issues.push(
      `Index size is ${storeSizeGB.toFixed(1)} GB. Consider archiving old data or adding nodes.`
    );
  }

  // 2. Check shard allocation
  const shardInfo = await this.esClient.cat.shards({
    index: indexName,
    format: 'json',
  });

  const unassignedShards = (shardInfo as any[]).filter(
    (s: any) => s.state === 'UNASSIGNED'
  );
  if (unassignedShards.length > 0) {
    issues.push(
      `${unassignedShards.length} unassigned shard(s). Cluster may not have enough nodes or disk space.`
    );
  }

  return {
    healthy: issues.length === 0,
    issues,
  };
}
```

> **Checkpoint:** You now have the three pillars of search observability: slow query logs catch individual bad queries, Prometheus metrics and SLOs catch systemic degradation, and index health checks catch infrastructure problems. Wire all three into your alerting system before you go to production.

---

## 10.13 Production War Stories and Common Mistakes

Theory is important, but nothing teaches like real failures. Here are the most painful problems we have encountered running Elasticsearch in production, each one a lesson that could save you hours of debugging.

### War Story 1: The Wrong Analyzer

**What happened:** A developer mapped the `city` field as `text` instead of `keyword`. The standard analyzer tokenized "New York" into ["new", "york"]. When a user filtered by `city: "New York"`, the filter matched every hotel in New York, but also every hotel with "new" in the city name -- "New Delhi," "New Orleans," "Newcastle." No one noticed for two weeks because "New York" results were technically included; users just saw strange extra results mixed in.

**How we found it:** A customer support ticket: "I searched for hotels in New York and got results in New Delhi." We checked the mapping:

```json
// BAD: city as text (tokenized)
"city": { "type": "text" }

// GOOD: city as keyword (exact match)
"city": { "type": "keyword" }
```

**The fix:** Changed the mapping to `keyword` and reindexed. The reindex took 2 minutes. The embarrassment lasted much longer.

**The lesson:** Use `keyword` for any field where users expect exact-value filtering: city names, country codes, amenity names, property types, currencies. Use `text` only when users expect full-text-search behavior (tokenization, stemming, fuzzy matching).

> **Common Mistake:** Defaulting to `text` type for string fields. Elasticsearch's dynamic mapping will automatically map strings as `text` with a `.keyword` sub-field if you do not define an explicit mapping. This seems convenient but wastes resources: you get a full-text tokenized inverted index for fields like `currency` that will only ever be filtered by exact value. Always define explicit mappings for production indexes.

### War Story 2: The Yellow Cluster at 3 AM

**What happened:** Our monitoring dashboard turned yellow on a Saturday night. Yellow means at least one replica shard is unassigned -- the cluster still serves searches, but it has lost redundancy. If another node dies, data loss is possible.

**Root cause:** A data node ran out of disk space. Elasticsearch has a built-in protection called the **disk watermark**: when a node's disk usage exceeds 85% (high watermark), Elasticsearch stops allocating new shards to it. At 90% (flood-stage watermark), it makes the index read-only. Our node hit 88%, and Elasticsearch could not allocate replica shards, so they sat in UNASSIGNED state.

```json
// Check disk watermark settings
GET /_cluster/settings?include_defaults=true&flat_settings=true

// The defaults:
"cluster.routing.allocation.disk.watermark.low": "85%"
"cluster.routing.allocation.disk.watermark.high": "90%"
"cluster.routing.allocation.disk.watermark.flood_stage": "95%"
```

**The fix:**
1. Freed disk space by deleting old, unused indices
2. Added monitoring alerts for disk usage at 75% (before the watermark kicks in)
3. Set up automated log rotation for Elasticsearch's own logs, which were consuming 12 GB

**The lesson:** Monitor disk usage per node, not just cluster-wide. One overfull node can cascade into cluster-wide degradation.

> **Production War Story:** The scariest variant of this is the **flood-stage lockout**. When a node hits 95% disk, Elasticsearch sets all indices to `read_only_allow_delete`. Your entire search stops accepting writes. To recover, you must free disk space AND manually clear the read-only flag:
> ```json
> PUT /hotels/_settings
> {
>   "index.blocks.read_only_allow_delete": null
> }
> ```
> We now alert at 70% disk usage to ensure we never reach this point.

### War Story 3: Mapping Explosion

**What happened:** A developer started indexing hotel metadata as dynamic key-value pairs:

```json
{
  "name": "Tokyo Grand Hotel",
  "metadata": {
    "early_check_in": "true",
    "pet_policy_dogs_small": "allowed",
    "pet_policy_dogs_large": "case-by-case",
    "pet_policy_cats": "allowed",
    "parking_type_valet": "available",
    "parking_type_self": "available",
    "parking_price_hourly": "15",
    "parking_price_daily": "45",
    // ... hundreds more per hotel
  }
}
```

Each unique key in `metadata` creates a new field in the mapping. With 500K hotels, each with slightly different metadata keys, the mapping grew to **47,000 fields**. Cluster state updates became slow, mapping refreshes consumed gigabytes of memory, and eventually the cluster started rejecting new documents with "Limit of total fields [1000] has been exceeded."

**The fix:** Restructured the metadata as an array of nested objects with a fixed schema:

```json
{
  "metadata": [
    { "key": "early_check_in", "value": "true" },
    { "key": "pet_policy_dogs_small", "value": "allowed" },
    { "key": "parking_price_daily", "value": "45" }
  ]
}
```

Now the mapping has exactly two fields (`metadata.key` and `metadata.value`) instead of 47,000.

**The lesson:** Set `index.mapping.total_fields.limit` to a reasonable number (default is 1,000) and never disable it. If you need truly dynamic key-value data, use the `flattened` field type or the nested array pattern above.

> **Common Mistake:** Disabling field limits with `"index.mapping.total_fields.limit": 100000`. This does not fix the problem -- it just delays the explosion until your cluster runs out of heap memory and crashes. Treat a high field count as a design problem, not a configuration problem.

### War Story 4: The Search Relevance Disaster

**What happened:** After deploying a `function_score` query with a `field_value_factor` on `review_count`, our top search results were dominated by a single hotel chain that had migrated from another platform and imported 50,000 reviews per property. Meanwhile, genuinely popular independent hotels with 500 organic reviews were buried on page 3.

**Root cause:** We used a linear `field_value_factor` without a modifier:

```json
// BAD: linear scaling -- 50,000 reviews = 100x more boost than 500 reviews
{
  "field_value_factor": {
    "field": "review_count",
    "factor": 1
  }
}

// GOOD: logarithmic scaling -- 50,000 reviews = ~2x more boost than 500 reviews
{
  "field_value_factor": {
    "field": "review_count",
    "factor": 1,
    "modifier": "log2p"
  }
}
```

With `log2p`, the difference between 500 and 50,000 reviews is `log2(50002) / log2(502)` = approximately 1.74x, not 100x.

**The fix:** Added the `log2p` modifier and ran A/B tests for a week comparing relevance quality before fully deploying.

**The lesson:** Always use a sublinear modifier (`log1p`, `log2p`, `sqrt`) for `field_value_factor` on unbounded numeric fields. Linear scaling lets outliers dominate your results.

> **What If You Skip This?** Relevance problems are insidious because they are invisible in unit tests. Your search "works" -- it returns results, it does not crash, the API responds in 15ms. But users see bizarre rankings and quietly lose trust. Always A/B test relevance changes with real users before deploying to 100% of traffic.

---

## 10.14 Chapter Summary

This chapter took you from SQL `LIKE '%tokyo%'` to a production-grade search engine serving complex, multi-dimensional queries in under 50 milliseconds. Here is a consolidated reference of everything we covered:

### Concept-Implementation-Production Reference Table

| Concept | What It Is | How We Implemented It | Production Consideration |
|---|---|---|---|
| **Inverted Index** | Data structure mapping terms to documents | Elasticsearch builds it automatically from your mapping | Monitor segment count; too many segments degrade search speed |
| **Shards & Replicas** | Data distribution and fault tolerance | 3 primary shards, 1 replica each for our hotels index | Aim for 20-40 GB per shard; replicas multiply read throughput |
| **Custom Analyzers** | Text processing pipelines for indexing and search | `hotel_name_analyzer` with synonyms, ASCII folding | Test analyzers with `_analyze` API before deploying mapping changes |
| **Geo-Distance Query** | Finding documents within a radius of a point | `geo_distance` filter with `geo_point` field type | Always use `filter` context (cached), not `must` (scored) |
| **Faceted Search** | Search results with aggregation counts | `terms`, `histogram`, `avg` aggregations with `post_filter` | Use `post_filter` only for the facet you want unfiltered counts for |
| **Auto-Complete** | Search-as-you-type suggestions | Completion suggester + edge n-gram fallback | Completion suggester lives in heap memory; monitor usage |
| **Fuzzy Search** | Typo-tolerant matching | `fuzziness: "AUTO"` with `prefix_length: 2` | Prefix length prevents excessive candidate expansion |
| **Bool Query** | Composing search criteria | `must` (scored), `filter` (cached), `should` (optional), `must_not` (exclude) | Prefer `filter` over `must` for non-scoring criteria |
| **Multi-Match** | Searching across multiple fields | Field boosting with `^` notation, `tie_breaker` for multi-field reward | Tune boosts with real search logs, not intuition |
| **function_score** | Business-aware relevance ranking | Decay functions for distance/price/recency, field_value_factor for ratings | Always use sublinear modifiers (log, sqrt) for unbounded fields |
| **Bulk Indexing** | High-throughput document loading | 500-doc batches, disabled refresh/replicas during load | Cursor-based pagination from MySQL, retry with backoff |
| **CDC Sync** | Keeping ES in sync with MySQL | Application-level dual write + Debezium safety net | Never block MySQL transactions on ES writes |
| **Slow Query Log** | Detecting performance regressions | Threshold-based logging at warn/info/debug levels | Review weekly; alert on warn-level entries |
| **Latency Monitoring** | Tracking search performance over time | Prometheus histograms with p50/p95/p99 SLOs | Alert on p95 > 250ms, investigate zero-result rate |
| **Index Health** | Monitoring infrastructure-level issues | Segment count, deleted doc ratio, disk usage, shard allocation | Alert on disk usage > 75%, unassigned shards |

### Key Takeaways

1. **Elasticsearch is not a database replacement.** It is a companion to your primary database. MySQL remains the source of truth for bookings and transactions. Elasticsearch provides fast, flexible search over a read-optimized copy of your data.

2. **Mapping design is as important as query design.** A `text` field where you need `keyword`, or a missing `geo_point`, will haunt you for the entire life of the index. Get the mapping right before you load data.

3. **Relevance tuning is never "done."** User expectations change, data distributions shift, and new properties join the platform. Budget time for ongoing relevance work -- analyzing zero-result queries, adjusting field boosts, and A/B testing scoring changes.

4. **Monitor everything.** Slow query logs, latency percentiles, zero-result rates, disk usage, segment counts. The search engine that is not monitored is the search engine that fails silently.

5. **Test with production-scale data.** A search query that works perfectly on 1,000 documents can fall apart on 500,000. Always benchmark with realistic data volumes before deploying to production.

> **Checkpoint:** You have now completed the search chapter. You can design an Elasticsearch index mapping with custom analyzers, build auto-complete with two strategies, compose queries using the full bool DSL with fuzzy matching and field boosting, tune relevance with decay functions and script scores, bulk-index data from MySQL with error handling, and monitor the whole thing in production. In the next chapter, we will connect this search service to the rest of our booking platform, wiring it into the API gateway and ensuring it stays in sync as bookings flow through the system.
