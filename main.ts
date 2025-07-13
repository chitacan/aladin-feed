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

await Deno.writeTextFile("feed.xml", feed.rss2());
console.log("Feed generated successfully!");