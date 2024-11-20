const { AtpAgent } = require("@atproto/api");
const Parser = require("rss-parser");
const axios = require("axios");

require("dotenv").config();
const parser = new Parser();

// Create a Bluesky Agent
const agent = new AtpAgent({
  service: "https://bsky.social",
});

async function getRSS() {
  // RSS keys: [ 'items', 'link', 'feedUrl', 'title', 'lastBuildDate' ]
  try {
    const rssURL = process.env.AU_RSS_FEED;
    const response = await axios.get(rssURL);
    const rssFeed = await parser.parseString(response.data);
    return rssFeed;
  } catch (error) {
    // Mute exception handling
    if (error.response) {
      // Server responded with a status outside of 2xx
      console.log("HTTP Error:", error.response.status, error.response.data);
    } else if (error.request) {
      // No response received
      console.log("No response received:", error.request);
    } else {
      // Other errors, e.g., request setup
      console.log("Error", error.message);
    }
  }
}

async function getLatestArticles(feed, auth) {
  if (!feed.items.length || !auth.did || !auth.token) {
    console.log("Empty feed");
    return;
  }

  const now = Date.now();
  const timespan = process.env.INTERVAL * 60 * 1000;
  const cutoffTime = now - timespan;

  const latestArticles = feed.items.filter((article) => {
    const pubDate = new Date(article.pubDate).getTime();
    console.log(
      `local time: ${now}, cutoff time ${cutoffTime}, pubdate: ${pubDate}`
    );
    return pubDate > cutoffTime && pubDate <= now;
  });

  if (!latestArticles.length) console.log("No new articles");

  const articleDetails = await Promise.all(
    latestArticles.map(async (article) => {
      const link = article.link || "";
      const title = article.title || "";
      const summary = article.summary || title;
      let imgDetails = {};

      try {
        const imgURL = await getImgDetails(link);

        const { imageBuffer, contentType } = await getImageBuffer(imgURL);

        imgDetails = await uploadImgToBsky(imageBuffer, contentType, auth);
      } catch (error) {
        console.error(`Failed to get image details for link ${link}:`, error);
      }

      const details = {
        $type: "app.bsky.feed.post",
        text: summary,
        createdAt: new Date().toISOString(),
        embed: {
          $type: "app.bsky.embed.external",
          external: {
            uri: link,
            title,
            description: summary,
          },
        },
      };

      if (imgDetails?.blob) {
        details.embed.external.thumb = imgDetails.blob;
      }

      return details;
    })
  );

  // const articleDetails = await Promise.all(
  //   latestArticles.map(async (article) => {
  //     const link = article.link || "";
  //     const title = article.title || "";
  //     const summary = article.summary || title;

  //     const details = {
  //       $type: "app.bsky.feed.post",
  //       text: summary,
  //       createdAt: new Date().toISOString(),
  //       embed: {
  //         $type: "app.bsky.embed.external",
  //         external: {
  //           uri: link,
  //           title,
  //           description: summary,
  //         },
  //       },
  //     };

  //     return details;
  //   })
  // );

  // const articleImgLinks = await Promise.all(
  //   articleDetails.map(async (article) => {
  //     const link = article.embed.external.uri;

  //     const imgURL = await getImgDetails(link);

  //     const details = { ...article, thumb: imgURL };

  //     return details;
  //   })
  // );

  // const articleBuffers = await Promise.all(
  //   articleImgLinks.map(async (article) => {
  //     const imgURL = article.thumb;

  //     const { imageBuffer, contentType } = await getImageBuffer(imgURL);

  //     const details = { ...article, thumb: { imageBuffer, contentType } };

  //     return details;
  //   })
  // );

  // const articleBlobs = await Promise.all(
  //   articleBuffers.map(async (article) => {
  //     const { imageBuffer, contentType } = article.thumb;
  //     let imgDetails = {};

  //     try {
  //       imgDetails = await uploadImgToBsky(imageBuffer, contentType, auth);
  //     } catch (error) {
  //       console.error(`Failed to get image details for link ${link}:`, error);
  //     }

  //     const details = {
  //       $type: article.$type,
  //       text: article.text,
  //       createdAt: article.createdAt,
  //       embed: {
  //         $type: article.embed.$type,
  //         external: {
  //           uri: article.embed.external.uri,
  //           title: article.embed.external.title,
  //           description: article.embed.external.description,
  //         },
  //       },
  //     };

  //     if (imgDetails?.blob) {
  //       details.embed.external.thumb = imgDetails.blob;
  //     }

  //     return details;
  //   })
  // );
  // return articleBlobs;

  return articleDetails;
}

async function getImgDetails(link) {
  try {
    const response = await axios.get(link);
    const html = response.data;

    const match = html.match(/<meta property="og:image" content="([^"]+)"/i);

    return match ? match[1] : false;
  } catch (error) {
    // Mute exception handling
    if (error.response) {
      // Server responded with a status outside of 2xx
      console.log("HTTP Error:", error.response.status, error.response.data);
    } else if (error.request) {
      // No response received
      console.log("No response received:", error.request);
    } else {
      // Other errors, e.g., request setup
      console.log("Error", error.message);
    }
  }
}

async function getImageBuffer(imgURL) {
  if (!imgURL) return { imageBuffer: "", contentType: "" };

  try {
    const response = await axios.get(imgURL, {
      responseType: "arraybuffer",
    });

    const contentType = response.headers["content-type"];
    const imageBuffer = Buffer.from(response.data);

    return { imageBuffer, contentType };
  } catch (error) {
    // Mute exception handling
    if (error.response) {
      // Server responded with a status outside of 2xx
      console.log("HTTP Error:", error.response.status, error.response.data);
    } else if (error.request) {
      // No response received
      console.log("No response received:", error.request);
    } else {
      // Other errors, e.g., request setup
      console.log("Error", error.message);
    }
  }
}

async function uploadImgToBsky(imageBuffer, contentType, auth) {
  if (!imageBuffer || !contentType) return {};

  try {
    const blobOptions = {
      method: "POST",
      url: process.env.UPLOAD_IMG_URL,
      headers: {
        Authorization: `Bearer ${auth.token}`,
        "Content-Type": contentType,
      },
      data: imageBuffer,
    };

    const response = await axios(blobOptions);

    return response.data;
  } catch (error) {
    // Mute exception handling
    if (error.response) {
      // Server responded with a status outside of 2xx
      console.log("HTTP Error:", error.response.status, error.response.data);
    } else if (error.request) {
      // No response received
      console.log("No response received:", error.request);
    } else {
      // Other errors, e.g., request setup
      console.log("Error", error.message);
    }
  }
}

async function BlueskyAuth() {
  try {
    // 1. Resolve handle
    const handleUrl = encodeURI(
      `${process.env.DID_URL}?handle=${process.env.BLUESKY_USERNAME}`
    );
    // Perform GET request to resolve handle
    const handleRep = await axios.get(handleUrl);
    const DID = handleRep.data.did;

    // 2. Get Token
    const tokenOpt = {
      method: "POST",
      url: process.env.API_KEY_URL,
      headers: {
        "Content-Type": "application/json",
      },
      data: {
        identifier: DID,
        password: process.env.BLUESKY_PASSWORD,
      },
    };

    // Perform POST request to get the token
    const tokenRep = await axios(tokenOpt);
    const TOKEN = tokenRep.data.accessJwt;

    // Return the DID and token as an object
    return { did: DID, token: TOKEN };
  } catch (error) {
    console.error(
      "Error in BlueskyAuth:",
      error.response ? error.response.data : error.message
    );
    throw error; // re-throw the error if needed
  }
}

async function postArticle(article) {
  await agent.post(article);
  console.log(
    `Article posted at ${new Date().toLocaleString()}:, ${article.text.slice(
      0,
      30
    )}...`
  );
}

async function publishFeed() {
  try {
    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD,
    });

    const auth = await BlueskyAuth();

    const rssFeed = await getRSS();
    const latestArticles = await getLatestArticles(rssFeed, auth);

    const results = await Promise.allSettled(
      latestArticles.map((article) => postArticle(article))
    );

    results.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(
          `Failed to post article at index ${index}:`,
          result.reason
        );
      } else {
        console.log(`Successfully posted article at index ${index}`);
      }
    });
  } catch (error) {
    console.log(error);
  }
}

export default async (req) => {
  await publishFeed();
};

// netlify functions:invoke blueskyBot --port 8888
