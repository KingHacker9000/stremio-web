// Copyright (C) 2017-2023 Smart code 203358507

const Addons = require('./Addons');
const Board = require('./Board');
const Discover = require('./Discover');
const Downloads = require('./Downloads/Downloads');
const Library = require('./Library');
const Calendar = require('./Calendar').default;
const MetaDetails = require('./MetaDetails');
const NotFound = require('./NotFound');
const Search = require('./Search');
const { default: Settings } = require('./Settings');
const Player = require('./Player');
const Intro = require('./Intro');

module.exports = {
    Addons,
    Board,
    Discover,
    Downloads,
    Library,
    Calendar,
    MetaDetails,
    NotFound,
    Search,
    Settings,
    Player,
    Intro
};
