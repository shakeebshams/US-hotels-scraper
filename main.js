
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import axios from 'axios';
dotenv.config();
import cities from './countries.json';
import { SearchQuery } from './graphql-queries.js';
import Apify from 'apify'
const { log, sleep, requestAsBrowser } = Apify.utils;
import cheerio from 'cheerio';
import pkg from 'mongodb';
const { MongoClient } = pkg;
const DBurl = process.env.MONGO_URI
let usa = cities["United States"];
let unique = [...new Set(usa)];

const dbName = 'hotels'
let db

MongoClient.connect(DBurl, { useNewUrlParser: true }, (err, client) => {
  if (err) return console.log(err);
  // Storing a reference to the database so you can use it later
  db = client.db(dbName);
  console.log(`Connected MongoDB: ${DBurl}`);
  console.log(`Database: ${dbName}`);
});

async function main() {

    //using for loop intead of for each as it would be processed async by default
    for (let i = 0; i < unique.length; i++) {
        try {
            let city = unique[i] + " usa";
            console.log("city being processed: " + city);
            let location_id = await get_location_id(city);
            await hotels_request(location_id);
        } catch (err) {
            console.error(error);
        }

    }
}

async function hotels_request(location_id) {
    let start_url = `https://api.tripadvisor.com/api/internal/1.14/location/${location_id}/hotels?currency=USD&lang=en&limit=50`
    let next = true
    try {
        while (next) {
            await axios.get(start_url, { 'headers': {'X-TripAdvisor-API-Key': process.env.API_KEY} })
                .then((response) => {
                    console.log(response.data.data.length);
                    process_data(response.data.data);
                    if (response.data.paging.next === null) {
                        next = false;
                    }
                    start_url = response.data.paging.next;
                })
                .catch((error) => {
                    console.log(error);
                    next = false;
                });
        }
    } catch (err) {
        console.log("error in request, skipping to another city");
        return;
    }
    return;
}

async function process_data(data) {
    for (let i = 0; i < data.length; i++) {
        let hotel = data[i];
        let hotel_data = {
            name: hotel.name,
            latitude: hotel.latitude,
            longitude: hotel.longitude,
            type: hotel.subcategory_type_label,
            tripadvisor_ranking: hotel.ranking,
            price_range: hotel.price,
            stars: hotel.hotel_class,
            description: hotel.description,
            website: hotel.website,
            phone: hotel.phone,
            email: hotel.email,
            address: hotel.address,
            city: hotel.address_obj.city,
            state: hotel.address_obj.state,
        }
        let collection = db.collection("hotels-again");
        await collection.insertOne(hotel_data, function(err, res) {
            if (err) {
                console.log(err);
            };
        })
    }
}




/**
 *
 * @param {string} query
 */
 async function get_location_id(query) {
    return callForSearch({
        query,
        client: await getClient(),
    });
}

/**
 * @template {(...args: any) => any} T
 * @typedef {ReturnType<T> extends Promise<infer U> ? U : never} UnwrappedPromiseFn
 */

/**
 * @typedef {UnwrappedPromiseFn<typeof getClient>} Client
 */

/**
 * @param {Apify.Session} [session]
 */
 async function getClient(session) {
    let securityToken;
    let cookies;
    let proxyUrl;

    const updateData = async (id = session?.id) => {
        proxyUrl = global.PROXY?.newUrl(id ?? `${Math.round(Math.random() * 100000)}`);

        const response = await requestAsBrowser({
            url: 'https://www.tripadvisor.com/Hotels-g28953-New_York-Hotels.html',
            proxyUrl,
            retries: 5,
        });

        const $ = cheerio.load(response.body);
        securityToken = getSecurityToken($);
        cookies = getCookies(response);
    };

    await updateData();

    if (!securityToken) {
        throw new Error('Missing securityToken');
    }

    // console.log({ securityToken, cookies });

    /**
     * @param {{
     *  url: string,
     *  method?: 'POST' | 'GET',
     *  payload?: Record<string, any>
     *  retries?: number
     * }} params
     */
    return async function req({ url, method = 'POST', payload, retries = 0 }) {
        const res = await requestAsBrowser({
            url: `https://www.tripadvisor.com/data/graphql${url}`,
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-requested-by': securityToken,
                Cookie: cookies,
            },
            json: true,
            // eslint-disable-next-line no-nested-ternary
            payload: (typeof payload === 'string'
                ? payload
                : payload ? JSON.stringify(payload) : undefined),
            abortFunction: () => false,
            proxyUrl,
        });

        if (res.statusCode !== 200) {
            if ((res.statusCode === 403 && retries < 10) || retries < 3) {
                await sleep(1000);
                if (!session?.id) {
                    await updateData();
                }
                log.debug('Retrying', { status: res.statusCode, url });
                return req({ url, method, payload, retries: retries + 1 });
            }
            session?.retire();
            throw new Error(`Status code ${res.statusCode}`);
        }

        return res.body;
    };
}

function getSecurityToken($) {
    let securityToken = null;
    $('head script').each((index, element) => {
        if ($(element).get()[0].children[0] && $(element).get()[0].children[0].data.includes("define('page-model', [], function() { return ")) {
            let scriptText = $(element).get()[0].children[0].data;
            scriptText = scriptText.replace("define('page-model', [], function() { return ", '');
            scriptText = scriptText.replace('; });', '');
            const scriptObject = JSON.parse(scriptText);
            securityToken = scriptObject.JS_SECURITY_TOKEN;
        }
    });
    return securityToken;
}

function getCookies(response) {
    return (response?.headers?.['set-cookie'] ?? []).map((d) => {
        const cookie = d.split(';');

        if (cookie.includes('TASession') || cookie.includes('TAUD')) {
            return cookie[0];
        }
    }).filter((s) => s).join('; ');
}

/**
 * @param {{
 *   query: string,
 *   client: general.Client,
 * }} param0
 */
async function callForSearch({ query, client }) {
    const response = await client({
        url: '/batched',
        payload: [{
            query: SearchQuery,
            variables: {
                request: {
                    query,
                    limit: 1,
                    scope: 'WORLDWIDE',
                    locale: 'en-US',
                    scopeGeoId: 1,
                    searchCenter: null,
                    types: [
                        'LOCATION',
                        'QUERY_SUGGESTION',
                        'LIST_RESULT',
                    ],
                    locationTypes: [
                        'GEO',
                        'AIRPORT',
                        'ACCOMMODATION',
                        'ATTRACTION',
                        'ATTRACTION_PRODUCT',
                        'EATERY',
                        'NEIGHBORHOOD',
                        'AIRLINE',
                        'SHOPPING',
                        'UNIVERSITY',
                        'GENERAL_HOSPITAL',
                        'PORT',
                        'FERRY',
                        'CORPORATION',
                        'VACATION_RENTAL',
                        'SHIP',
                        'CRUISE_LINE',
                        'CAR_RENTAL_OFFICE',
                    ],
                    userId: null,
                    context: {
                        typeaheadId: Date.now(),
                        uiOrigin: 'SINGLE_SEARCH_HERO',
                    },
                    articleCategories: [],
                    enabledFeatures: ['typeahead-q'],
                },
            },
        }],
    });

    try {
        return response[0].data.Typeahead_autocomplete.results[0].locationId;
    } catch (e) {
        log.debug('search failed', { e: e.message, data: response[0]?.data, results: response?.[0]?.data?.Typeahead_autocomplete });
        throw new Error(`Nothing found for "${query}"`);
    }
}
main()