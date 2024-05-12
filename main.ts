import { Feed } from "npm:feed@4";
import { cheerio } from "https://deno.land/x/cheerio@1.0.7/mod.ts";
import { parse } from "https://deno.land/std@0.179.0/flags/mod.ts";

const args = parse(Deno.args);

if (!import.meta.main) {
  Deno.exit(0);
}

if (args["help"]) {
  console.log(`
  Usage
    $ deno run -A main.ts
`);
  Deno.exit(0);
}

const email = Deno.env.get('ALADIN_EMAIL');
const password = Deno.env.get('ALADIN_PASSWORD');

if (!email || !password) {
  console.log('ALADIN_EMAIL and ALADIN_PASSWORD environment variables are required.');
  Deno.exit(1);
}

const formData = new URLSearchParams({
  Email: email,
  Password: password,
  Action: '1',
  ReturnUrl: '',
});

const loginResponse = await fetch('https://www.aladin.co.kr/login/wlogin_popup.aspx', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  },
  body: formData.toString(),
});

const loginHTML = await loginResponse.text();

if (!loginHTML.includes('window.location.href')) {
  throw new Error('Login failed with ' + loginResponse);
}

const [user, session, us, login] = loginResponse.headers.getSetCookie()
  .map(d => d.split(';')[0]);

const basketResponse = await fetch('https://aladin.co.kr/shop/wsafebasket.aspx?start=we', {
  credentials: 'include',
  headers: {
    Cookie: `${user}; ${session}; ${us}; ${login}; ordersavebasket=ViewType=Simple&ViewRowsCount=96`,
  }
});

const basketHTML = await basketResponse.text();
const $ = cheerio.load(basketHTML);
const books$ = $('#Myform > *:nth-child(2) > table > * > * > td tr:nth-child(2)');

const books = books$.map((_i, el) => {
  const book$ = $(el);
  const title = book$.find('a').text();
  const link = book$.find('a').attr('href')!;
  const id = new URL(link || '').searchParams.get('ItemId')!;
  const rawPrice = book$.find('.ss_p').first().text();
  const price = parseInt(rawPrice.replace(/,/g, ''));
  const date = book$.find('.fontcolor_gray').text()
    .replace(/(일에 보관$|\s)/g, '')
    .replace(/\D/g, '-');
  const coverImage = book$.prev().find('img').attr('src');

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
    author: [{name: 'chitacan', link: 'https://github.com/chitacan'}],
    date: new Date(date),
  };
});

const feed = new Feed({
  title: 'aladin basket',
  description: "chitacan's personal dogdrip feed",
  id: 'aladin',
  link: 'https://www.aladin.co.kr/shop/wsafebasket.aspx',
  image: "https://image.aladin.co.kr/img/logo_big.jpg",
  favicon: 'https://image.aladin.co.kr/img/home/aladin.ico',
  copyright: 'All rights reserved 2024, chiatacn',
  updated: new Date(),
  feedLinks: {
    json: ""
  },
  author: {
    name: "chitacan",
    link: "https://github.com/chitacan"
  }
});

for(const book of books) {
  feed.addItem(book);
}

await Deno.writeTextFile('feed.xml', feed.rss2());