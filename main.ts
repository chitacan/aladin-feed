import { Feed } from "npm:feed@4";
import { DOMParser, Element } from "jsr:@b-fuze/deno-dom";
import { parseArgs } from "jsr:@std/cli/parse-args";
import { Jimp } from "npm:jimp";

const BASE_URL = "https://www.aladin.co.kr";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const flags = parseArgs(Deno.args, {
  boolean: ["help"],
});

if (!import.meta.main) {
  Deno.exit(0);
}

if (flags.help) {
  console.log(`
  Usage
    $ deno run -A main.ts
`);
  Deno.exit(0);
}

const EMAIL = Deno.env.get("ALADIN_EMAIL");
const PASSWORD = Deno.env.get("ALADIN_PASSWORD");
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
const ROAM_API_KEY = Deno.env.get("ROAM_API_KEY");
const ROAM_WRITE_URL = "https://api.roamresearch.com/api/graph/chitacan/write";
const PREV_FEED_PATH = "prev-feed.xml";

if (!EMAIL || !PASSWORD || !OPENAI_API_KEY) {
  console.log("Cannot find required environment variables.");
  Deno.exit(1);
}

async function readCaptcha(): Promise<
  {
    cookies: string[];
    body: { txtCaptcha: string } | Record<string | number | symbol, never>;
  }
> {
  const { html: loginHTML, cookies } = await fetch(
    `${BASE_URL}/login/wlogin.aspx?returnurl=/`,
    {
      headers: {
        "User-Agent": USER_AGENT,
      },
    },
  )
    .then(async (res) => {
      const cookies = res.headers.getSetCookie().map((d) => d.split(";")[0]);
      const html = await res.text();
      return { html, cookies };
    });

  const login$ = new DOMParser()
    .parseFromString(loginHTML, "text/html");
  const captcha = login$.querySelector("#imgCaptcha");

  if (!captcha) {
    return { cookies, body: {} };
  }

  const now = new Date();
  const imageURL = encodeURI(
    `${BASE_URL}/ucl/aladdin/captcha.ashx?x=${now.toUTCString()}`,
  );

  const buffer = await fetch(imageURL, {
    credentials: "include",
    headers: {
      "Accept": "image/*",
      Cookie: cookies.join("; "),
    },
  }).then(res => res.arrayBuffer());

  const img = await Jimp.read(buffer);
  const dataURL = await img.getBase64("image/png");
  const png = await img.getBuffer("image/png");

  await Deno.writeFile("captcha.png", png);

  const result = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        {
          "role": "user",
          "content": [
            {
              "type": "text",
              "text":
                "What is the 4 numbers in this image? Please include only 4 numbers in your response.",
            },
            {
              "type": "image_url",
              "image_url": {
                "url": dataURL,
              },
            },
          ],
        },
      ],
    }),
  })
    .then((res) => res.json());

  const captchaResult = result.choices[0].message.content;
  return {
    cookies,
    body: { txtCaptcha: captchaResult },
  };
}

const captchaResult = await readCaptcha();

console.log("Fetching login form...");
const loginForm = await fetch(`${BASE_URL}/login/wlogin.aspx?returnurl=/`, {
  method: "POST",
  credentials: "include",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: captchaResult.cookies.join("; "),
  },
  body: new URLSearchParams({
    Email: EMAIL,
    Password: PASSWORD,
    Action: "1",
    ReturnUrl: "",
    ...captchaResult.body,
  }).toString(),
});

const loginFormHTML = await loginForm.text();
const loginCookies = loginForm.headers.getSetCookie().map((d) =>
  d.split(";")[0]
);

const match = loginFormHTML.match(/<script>alert\(\"(.*)\"\)/);
if (match) {
  console.error(`Login failed with: ${match[1]}`);
  Deno.exit(1);
}

// if (!loginFormHTML.includes("document.location.href")) {
//   console.error("Login failed with redirections");
//  Deno.exit(1);
// }

console.log("Fetching basket page...");
const basketHTML = await fetch(`${BASE_URL}/shop/wsafebasket.aspx?start=we`, {
  credentials: "include",
  headers: {
    Cookie: [
      ...captchaResult.cookies,
      ...loginCookies,
      "ordersavebasket=ViewType=Simple&ViewRowsCount=96",
    ].join("; "),
  },
})
  .then((res) => res.text());

const basket$ = new DOMParser().parseFromString(basketHTML, "text/html");
const selector =
  "#Myform > *:nth-child(2) > table > * > * > td tr:nth-child(2)";
const books = Array.from(basket$.querySelectorAll(selector))
  .map((bookHTML) => {
    const title = bookHTML.querySelector("a")!.textContent;
    const link = bookHTML.querySelector("a")!.getAttribute("href")!;
    const id = new URL(link || "").searchParams.get("ItemId")!;
    const rawPrice = bookHTML.querySelector(".ss_p")?.textContent;
    const price = parseInt(rawPrice?.replace(/,/g, "") || "0");
    const date = bookHTML.querySelector(".fontcolor_gray")!.textContent
      .replace(/(일에 보관$|\s)/g, "")
      .replace(/\D/g, "-");
    const coverImage = (bookHTML.previousSibling as Element)
      ?.querySelector("img")?.getAttribute("src");
    return {
      id,
      guid: id,
      title,
      link,
      description: `![](${coverImage})
  ${rawPrice}원`,
      content: JSON.stringify({
        price,
        coverImage,
      }),
      author: [{ name: "chitacan", link: "https://github.com/chitacan" }],
      date: new Date(date),
    };
  });

const feed = new Feed({
  title: "aladin basket",
  description: "chitacan's personal dogdrip feed",
  id: "aladin",
  link: "https://www.aladin.co.kr/shop/wsafebasket.aspx",
  image: "https://image.aladin.co.kr/img/logo_big.jpg",
  favicon: "https://image.aladin.co.kr/img/home/aladin.ico",
  copyright: "All rights reserved 2025, chiatacn",
  updated: new Date(),
  feedLinks: {
    json: "",
  },
  author: {
    name: "chitacan",
    link: "https://github.com/chitacan",
  },
});

for (const book of books) {
  feed.addItem(book);
}

type Book = typeof books[number];

// 이전 피드의 guid(ItemId) 목록. 이전 피드가 없거나 비어 있으면 null.
async function readPrevIds(): Promise<Set<string> | null> {
  try {
    const xml = await Deno.readTextFile(PREV_FEED_PATH);
    const ids = Array.from(
      xml.matchAll(/<guid[^>]*>(.+?)<\/guid>/g),
      (m) => m[1],
    );
    return ids.length ? new Set(ids) : null;
  } catch {
    return null;
  }
}

// 오늘(KST) Roam 데일리 노트 uid (MM-DD-YYYY)
function todayDailyNoteUid() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(kst.getUTCMonth() + 1)}-${pad(kst.getUTCDate())}-${kst.getUTCFullYear()}`;
}

async function addToRoam(newBooks: Book[]) {
  const dailyNote = todayDailyNoteUid();
  const actions = newBooks.flatMap((book, i) => {
    const uid = -(i + 1);
    const { price, coverImage } = JSON.parse(book.content);
    return [
      {
        action: "create-block",
        location: {
          "page-title": { "daily-note-page": dailyNote },
          order: "last",
        },
        block: {
          string: `#[[${book.title}]] [link](${book.link}) #books #aladin`,
          uid,
        },
      },
      {
        action: "create-block",
        location: { "parent-uid": uid, order: "last" },
        block: {
          string: `![](${coverImage})\n\n${price.toLocaleString("ko-KR")}원`,
        },
      },
    ];
  });

  const res = await fetch(ROAM_WRITE_URL, {
    method: "POST",
    headers: {
      "x-authorization": `Bearer ${ROAM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "batch-actions", actions }),
  });
  if (!res.ok) {
    throw new Error(`Roam write failed: ${res.status} ${await res.text()}`);
  }
}

// Roam 쓰기가 실패하면 feed.xml 을 만들지 않고 종료해서, 다음 실행에서 다시 시도하게 한다.
const prevIds = await readPrevIds();
if (!prevIds) {
  console.log("No previous feed. Skipping Roam sync.");
} else if (!ROAM_API_KEY) {
  console.log("ROAM_API_KEY is not set. Skipping Roam sync.");
} else {
  const newBooks = books.filter((book) => !prevIds.has(book.id));
  if (newBooks.length) {
    console.log(`Adding ${newBooks.length} new book(s) to Roam...`);
    newBooks.forEach((book) => console.log(`  - ${book.title}`));
    await addToRoam(newBooks);
  } else {
    console.log("No new books.");
  }
}

await Deno.writeTextFile("feed.xml", feed.rss2());
console.log("Feed generated successfully!");