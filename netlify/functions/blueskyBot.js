const { AtpAgent } = require("@atproto/api");
const RSSParser = require("rss-parser");
const axios = require("axios");
const parser = new RSSParser();
const sharp = require("sharp");

require("dotenv").config();

let posting = false;

const agent = new AtpAgent({
  service: "https://bsky.social",
});

async function fetchRSSFeed(url) {
  try {
    const feed = await parser.parseURL(url);

    feed.items.sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));

    return feed;
  } catch (error) {
    console.error("fetchRSSFeed error:", error);
    return null;
  }
}

async function fetchGitHubJSON(rawUrl) {
  try {
    const response = await axios.get(rawUrl);

    return JSON.parse(
      Buffer.from(response.data.content, "base64").toString("utf8")
    );
  } catch (error) {
    console.error("fetchGitHubJSON error:", error);
    return null;
  }
}

function getNewArticles(rssFeed, jsonLinks) {
  const jsonLinksSet = new Set(jsonLinks.map((item) => item.link));
  return rssFeed.items.filter((article) => !jsonLinksSet.has(article.link));
}

async function getImageBlob(link, title, maxSizeInBytes = 1024 * 1024) {
  try {
    const { data } = await axios.get(link, { responseType: "text" });

    const match = data.match(/<meta property="og:image" content="([^"]+)"/i);

    if (!match || !match[1]) return null;

    const baseImageUrl = match[1].split("?")[0];
    const optimizedImageUrl = `${baseImageUrl}?xlib=rb-4.1.0&q=45&w=500&fit=crop&fm=webp`;

    // Fetch the image as a binary buffer
    const response = await axios.get(optimizedImageUrl, {
      responseType: "arraybuffer",
    });

    let contentType = response.headers["content-type"];

    let imageBuffer = response.data;

    // Check if the buffer is already under 1MB
    if (imageBuffer.length <= maxSizeInBytes) {
      return { imageBuffer, contentType };
    }

    let quality = 80; // Start with 80% quality
    let width = 500; // Initial width for resizing
    let resizedImageBuffer;

    // Resize and compress iteratively until size is under 1MB
    do {
      console.log(
        `"${title.slice(
          0,
          20
        )}..." image too big, resizing - quality: ${quality}, width: ${width}`
      );

      resizedImageBuffer = await sharp(imageBuffer)
        .resize({ width }) // Resize width while preserving aspect ratio
        .jpeg({ quality }) // Compress with adjustable quality
        .toBuffer();

      contentType = "image/jpeg";

      // Reduce quality or size for the next iteration
      if (resizedImageBuffer.length > maxSizeInBytes) {
        if (quality > 10) {
          quality -= 10; // Decrease quality in steps
        } else {
          width -= 100; // Decrease width if quality is too low
          if (width <= 0) throw new Error("Image cannot be resized under 1MB.");
        }
      }
    } while (resizedImageBuffer.length > maxSizeInBytes);

    console.log(`"${title.slice(0, 20)}..." image resized under 1MB`);

    return { imageBuffer: resizedImageBuffer, contentType };
  } catch (error) {
    console.error("getImageBlob error", error.message);
    return null;
  }
}

async function uploadImgToBsky(imageBuffer, contentType) {
  try {
    // Attempt to upload the image
    const { data } = await agent.uploadBlob(imageBuffer, {
      encoding: contentType,
    });

    return data;
  } catch (error) {
    console.error(`uploadImgToBsky error: ${error.message}`);
    return null;
  }
}

async function generateArticleData(feed) {
  const articles = [];

  for (let i = 0; i < feed.length; i++) {
    const item = feed[i];
    const link = item.link;
    const title = item.title;
    const summary = item.summary || title;

    const imageBlob = await getImageBlob(link, title);

    if (!imageBlob || !imageBlob.imageBuffer || !imageBlob.contentType) {
      articles.push(null);
      continue;
    }

    // Upload image to Bsky
    const imageData = await uploadImgToBsky(
      imageBlob.imageBuffer,
      imageBlob.contentType
    );

    if (!imageData || !imageData.blob) {
      console.log(
        `${title.slice(0, 20)} image didn't upload correctly, skipping`
      );
      articles.push(null);
      continue;
    }

    articles.push({
      $type: "app.bsky.feed.post",
      text: summary,
      createdAt: new Date().toISOString(),
      embed: {
        $type: "app.bsky.embed.external",
        external: {
          uri: link,
          title: title,
          description: summary,
          thumb: imageData.blob,
        },
      },
    });
  }

  // Filter out any null results
  return articles.filter((article) => article !== null);
}

async function postArticle(article) {
  try {
    await agent.post(article);
    console.log("Article posted:", article.text);
    return true;
  } catch (error) {
    console.error("postArticle error", error);
    return null;
  }
}

async function processArticles(newArticles) {
  try {
    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD,
    });

    const newArticleData = await generateArticleData(newArticles);

    for (let i = 0; i < newArticleData.length; i++) {
      let success = await postArticle(newArticleData[i]);
      newArticleData[i].success = success;
    }

    return newArticleData;
  } catch (error) {
    console.log("processArticles error", error);
    return null;
  }
}

async function updateGitHubJSON(content, authToken) {
  const apiUrl = process.env.GITHUB_JSON_API_URL;

  try {
    const getResponse = await axios.get(apiUrl, {
      headers: {
        Authorization: `token ${authToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    const sha = getResponse.data.sha;

    const updateResponse = await axios.put(
      apiUrl,
      {
        message: "Update JSON file with new links",
        content: Buffer.from(JSON.stringify(content, null, 2)).toString(
          "base64"
        ),
        sha: sha,
      },
      {
        headers: {
          Authorization: `token ${authToken}`,
          Accept: "application/vnd.github.v3+json",
        },
      }
    );

    if (updateResponse.status === 200) console.log("JSON links updated!");
  } catch (error) {
    console.error("updateGitHubJSON error:", error);
  }
}

async function main() {
  try {
    // Fetch RSS feed and github JSON at the same time
    const [rssFeed, jsonLinks] = await Promise.all([
      fetchRSSFeed(process.env.RSS_FEED),
      fetchGitHubJSON(process.env.GITHUB_JSON_RAW_URL),
    ]);

    if (!rssFeed || !rssFeed.items.length || !jsonLinks) {
      console.log("Error fetching RSS feed or github JSON");
      return null;
    }

    const newArticles = getNewArticles(rssFeed, jsonLinks);

    if (newArticles.length > 0) {
      posting = true;
      console.log(
        `${newArticles.length} new articles found, attempting to post`
      );

      // Process new links
      const processedArticles = await processArticles(newArticles);

      // extract the article links that were posted
      const postedArticleLinks = processedArticles
        .filter((article) => article.success === true)
        .map((item) => ({
          link: item.embed.external.uri,
          published: true,
        }));

      // Update the GitHub JSON file
      const updatedLinks = [...postedArticleLinks, ...jsonLinks].slice(0, 200);
      await updateGitHubJSON(updatedLinks, process.env.GITHUB_PAT);

      return updatedLinks;
    } else {
      console.log("No new articles.");
    }
  } catch (error) {
    console.error("main error:", error);
    return null;
  }
}

// main();

export default async (req, _) => {
  if (!posting) {
    await main();
  }
  // const publishedArticles = await main();
  // return Response.json({ articles: JSON.stringify(publishedArticles) });
};
