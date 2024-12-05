const { BskyAgent } = require("@atproto/api");
const RSSParser = require("rss-parser");
const axios = require("axios");
const parser = new RSSParser();

require("dotenv").config();

const agent = new BskyAgent({
  service: "https://bsky.social",
});

async function fetchRSSFeed(url) {
  try {
    const feed = await parser.parseURL(url);
    return feed;
  } catch (error) {
    console.error("fetchRSSFeed error:", error);
    throw error;
  }
}

async function fetchGitHubJSON(rawUrl) {
  try {
    const response = await axios.get(rawUrl, {
      owner: "mjkgarrow",
      repo: "TC-RSS",
      path: "links.json",
      headers: {
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    return JSON.parse(
      Buffer.from(response.data.content, "base64").toString("utf8")
    );
  } catch (error) {
    console.error("fetchGitHubJSON error:", error);
    throw error;
  }
}

function getNewArticles(rssFeed, jsonLinks) {
  const jsonLinksSet = new Set(jsonLinks);
  return rssFeed.items.filter((article) => !jsonLinksSet.has(article.link));
}

async function getImageBlob(link) {
  try {
    const res = await fetch(link);
    const html = await res.text();

    const match = html.match(/<meta property="og:image" content="([^"]+)"/i);

    if (!match) return;

    const response = await axios.get(match[1], {
      responseType: "arraybuffer",
    });

    const contentType = response.headers["content-type"];
    const imageBuffer = Buffer.from(response.data);

    return { imageBuffer, contentType };
  } catch (error) {
    console.error(`getImageBlob error: ${error}`);
  }
}

async function resizeImageUntilAcceptable(imageBuffer, contentType) {
  let resizedBuffer = imageBuffer;
  let width = 2048; // Starting width
  let quality = 90; // Starting quality
  const format = contentType.includes("png") ? "png" : "jpeg";

  while (true) {
    resizedBuffer = await sharp(imageBuffer)
      .resize({ width })
      .toFormat(format, { quality })
      .toBuffer();

    // Check if the size is acceptable (below the maximum allowed size)
    if (
      resizedBuffer.length <= MAX_SIZE_IN_BYTES ||
      width <= 500 ||
      quality <= 50
    ) {
      break;
    }

    // Reduce width and quality for the next iteration
    width -= 200;
    quality -= 10;
  }

  return resizedBuffer;
}

async function uploadImgToBsky(imageBuffer, contentType) {
  try {
    // Attempt to upload the image
    const { data } = await agent.uploadBlob(imageBuffer, {
      encoding: contentType,
    });

    return data;
  } catch (error) {
    if (error.status === 400 && error.error === "BlobTooLarge") {
      console.error("Image is too large:", error.message);

      // Resize the image until acceptable
      const resizedImageBuffer = await resizeImageUntilAcceptable(
        imageBuffer,
        contentType
      );

      // Retry uploading the resized image
      try {
        const { data } = await agent.uploadBlob(resizedImageBuffer, {
          encoding: contentType,
        });

        return data;
      } catch (retryError) {
        console.error(`Error uploading resized image: ${retryError.message}`);
        throw retryError;
      }
    } else {
      console.error(`uploadImgToBsky error: ${error.message}`);
      throw error;
    }
  }
}

async function generateArticleData(feed) {
  // First stage: Fetch all image blobs concurrently
  const imageBlobPromises = feed.map(async (item) => {
    try {
      return await getImageBlob(item.link); // Ensure the result is awaited
    } catch (error) {
      console.error(`Error processing item ${item.link}:`, error);
      return null; // Handle errors and return null for failed items
    }
  });

  const imageBlobs = await Promise.all(imageBlobPromises);

  // Second stage: Process each resolved imageBlob
  const articles = await Promise.all(
    imageBlobs.map(async (imageBlob, index) => {
      if (!imageBlob) return null; // Skip failed items

      const item = feed[index];
      const link = item.link;
      const title = item.title;
      const summary = item.summary || title;

      // Upload image to Bsky
      const imageData = await uploadImgToBsky(
        imageBlob.imageBuffer,
        imageBlob.contentType
      );

      return {
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
            // thumb: "",
          },
        },
      };
    })
  );

  // Filter out any null results
  return articles.filter((article) => article !== null);
}

async function postArticle(article) {
  await agent.post(article);
  console.log("Article posted:", article.text);
}

async function processArticles(newArticles) {
  try {
    await agent.login({
      identifier: process.env.BLUESKY_USERNAME,
      password: process.env.BLUESKY_PASSWORD,
    });

    const newArticleData = await generateArticleData(newArticles);

    newArticleData
      .reverse()
      .forEach(async (article) => await postArticle(article));

    return newArticleData;
  } catch (error) {
    console.log("postArticle error", error);
  }
}

async function updateGitHubJSON(content, authToken) {
  const apiUrl = process.env.GITHUB_JSON_API_URL;

  try {
    // Get the SHA of the existing file
    const getResponse = await axios.get(apiUrl, {
      headers: {
        Authorization: `token ${authToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    });

    const sha = getResponse.data.sha;

    // Update the file
    const updateResponse = await axios.put(
      apiUrl,
      {
        owner: "mjkgarrow",
        repo: "TC-RSS",
        path: "links.json",
        message: "Update JSON file with new links",
        content: Buffer.from(JSON.stringify(content)).toString("base64"),
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
    console.error("updateGitHubJSON errir:", error.response.data);
  }
}

async function main() {
  try {
    // Fetch RSS feed and github JSON at the same time
    const [rssFeed, jsonLinks] = await Promise.all([
      fetchRSSFeed(process.env.RSS_FEED),
      fetchGitHubJSON(process.env.GITHUB_JSON_RAW_URL),
    ]);

    // Find new links
    const newArticles = getNewArticles(rssFeed, jsonLinks);

    const newLinks = newArticles.map((item) => item.link);

    if (newArticles.length > 0) {
      // Process new links
      await processArticles(newArticles);

      // Update the GitHub JSON file
      const updatedLinks = [...newLinks, ...jsonLinks].slice(0, 50);
      await updateGitHubJSON(updatedLinks, process.env.GITHUB_PAT);
    } else {
      console.log("No new articles.");
    }
  } catch (error) {
    console.error("main error:", error);
  }
}

// main();

export default async (req, _) => {
  const publishedArticles = await main();
  return Response.json({ articles: JSON.stringify(publishedArticles) });
};
